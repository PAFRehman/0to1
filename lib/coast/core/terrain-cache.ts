import * as THREE from 'three'
import { cacheStaticShadows } from './static-shadows'

const vertexShader = `
varying vec2 vUv;
#include <common>
#include <shadowmap_pars_vertex>
void main() { vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, -1., 1.); }
`
const fragmentShader = `
uniform sampler2D uLandLit, uLandAmbient, uLandDepth;
uniform mat4 uWorldFromClip;
varying vec2 vUv;
#include <common>
#include <packing>
#include <shadowmap_pars_fragment>
#if NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
#endif
void main() {
  float depth = texture2D(uLandDepth, vUv).x;
  if (depth >= 1.) discard;
  vec4 p = uWorldFromClip * vec4(vUv * 2. - 1., depth * 2. - 1., 1.);
  vec3 world = p.xyz / p.w;
  float sun = 1.;
  #if NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow s = directionalLightShadows[0];
    vec3 normal = normalize(cross(dFdx(world), dFdy(world)));
    if (dot(normal, cameraPosition - world) < 0.) normal = -normal;
    vec4 coord = directionalShadowMatrix[0] * vec4(world + normal * s.shadowNormalBias, 1.);
    sun = getShadow(directionalShadowMap[0], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, coord);
  #endif
  vec4 land = texture2D(uLandLit, vUv);
  if (land.a < .001) discard;
  vec3 lit = land.rgb / land.a;
  vec3 ambient = texture2D(uLandAmbient, vUv).rgb / land.a;
  gl_FragColor = vec4(mix(ambient, lit, sun), land.a);
  gl_FragDepth = depth;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Cache only immutable land lighting; live depth-tested water, plants, clouds and moving shadows remain 3D. */
export function cacheTerrainLighting(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, samples: number) {
  const terrain = scene.getObjectByName('terrain')
  if (!terrain) return null
  const layer = 6, size = new THREE.Vector2()
  const options = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, stencilBuffer: false }
  const lit = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: true })
  lit.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
  const ambient = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: false })
  let dirty = true, baking = false, ready = false, disposed = false
  const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, lights: true, alphaToCoverage: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      uLandLit: { value: lit.texture }, uLandAmbient: { value: ambient.texture }, uLandDepth: { value: lit.depthTexture }, uWorldFromClip: { value: new THREE.Matrix4() },
    },
  })
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const composite = new THREE.Mesh(geometry, material)
  composite.name = 'terrain-lighting-cache'; composite.frustumCulled = false; composite.receiveShadow = true; composite.renderOrder = -1e8
  scene.add(composite); composite.visible = false
  const originals: { mesh: THREE.Mesh; before: THREE.Mesh['onBeforeRender']; after: THREE.Mesh['onAfterRender']; start: number; count: number; layers: number; visible: boolean }[] = []
  const immutable: THREE.Object3D[] = [terrain]
  scene.traverse(object => { if (object.userData.staticLighting) immutable.push(object) })
  for (const surface of immutable) surface.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    const record = { mesh: object, before: object.onBeforeRender, after: object.onAfterRender, start: object.geometry.drawRange.start, count: object.geometry.drawRange.count, layers: object.layers.mask, visible: object.visible }
    originals.push(record); object.layers.enable(layer)
    object.onBeforeRender = function(...args) {
      record.before.apply(this, args)
      if (ready && !baking && args[2] === camera) this.geometry.setDrawRange(0, 0)
      else this.geometry.setDrawRange(record.start, record.count)
    }
    object.onAfterRender = function(...args) { this.geometry.setDrawRange(record.start, record.count); record.after.apply(this, args) }
  })
  const sunLayers = sun.layers.mask, hemiLayers = hemi.layers.mask
  sun.layers.enable(layer); hemi.layers.enable(layer)
  const shadows = cacheStaticShadows(scene, camera, renderer, sun, originals.map(r => r.mesh))
  return {
    invalidate() { dirty = true },
    prepare() {
      if (!dirty || disposed) return
      renderer.getDrawingBufferSize(size)
      lit.setSize(size.x, size.y); ambient.setSize(size.x, size.y)
      // Keep the original foliage edge antialiasing while baking. Release its multisample
      // attachments immediately afterwards, retaining just two HDR maps and the native 3D depth.
      const staging = new THREE.WebGLRenderTarget(size.x, size.y, { ...options, samples, depthBuffer: true })
      staging.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType)
      const previous = { target: renderer.getRenderTarget(), layers: camera.layers.mask, shadow: renderer.shadowMap.enabled, tone: renderer.toneMapping, auto: renderer.autoClear, clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), sun: sun.intensity }
      baking = true; composite.visible = false
      originals.forEach(r => { r.mesh.visible = r.visible })
      try {
        camera.layers.set(layer); renderer.toneMapping = THREE.NoToneMapping
        renderer.autoClear = true; renderer.setClearColor(0x000000, 0)
        shadows.bake(staging); renderer.shadowMap.enabled = false
        renderer.initRenderTarget(lit); renderer.initRenderTarget(ambient)
        renderer.setRenderTarget(staging); renderer.render(scene, camera)
        renderer.copyTextureToTexture(staging.texture, lit.texture)
        renderer.copyTextureToTexture(staging.depthTexture, lit.depthTexture!)
        sun.intensity = 0; renderer.setRenderTarget(staging); renderer.render(scene, camera)
        renderer.copyTextureToTexture(staging.texture, ambient.texture)
        material.uniforms.uWorldFromClip.value.copy(camera.projectionMatrixInverse).premultiply(camera.matrixWorld)
        dirty = false; ready = true
      } finally {
        sun.intensity = previous.sun; camera.layers.mask = previous.layers; renderer.shadowMap.enabled = previous.shadow
        renderer.toneMapping = previous.tone; renderer.autoClear = previous.auto; renderer.setClearColor(previous.clear, previous.alpha)
        renderer.setRenderTarget(previous.target); baking = false; composite.visible = ready
        originals.forEach(r => { r.mesh.visible = ready ? false : r.visible })
        staging.dispose(); staging.depthTexture?.dispose()
      }
    },
    dispose() {
      if (disposed) return; disposed = true
      for (const r of originals) { r.mesh.onBeforeRender = r.before; r.mesh.onAfterRender = r.after; r.mesh.layers.mask = r.layers; r.mesh.visible = r.visible; r.mesh.geometry.setDrawRange(r.start, r.count) }
      shadows.dispose(); sun.layers.mask = sunLayers; hemi.layers.mask = hemiLayers
      composite.removeFromParent(); geometry.dispose(); material.dispose(); lit.dispose(); ambient.dispose(); lit.depthTexture?.dispose()
    },
  }
}
