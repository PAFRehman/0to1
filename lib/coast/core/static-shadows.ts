import * as THREE from 'three'

/** Reuse only the unmoving casters. Wind-driven plants and articulated actors still cast live shadows. */
export function cacheStaticShadows(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, sun: THREE.DirectionalLight, surfaces: THREE.Mesh[]) {
  let ready = false, baking = false
  const target = new THREE.WebGLRenderTarget(sun.shadow.mapSize.x, sun.shadow.mapSize.y, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter })
  const material = new THREE.ShaderMaterial({
    uniforms: { uStaticShadow: { value: target.texture } },
    vertexShader: 'varying vec2 vUv; void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: 'uniform sampler2D uStaticShadow; varying vec2 vUv;\n#include <packing>\nvoid main(){vec4 texel=texture2D(uStaticShadow,vUv);gl_FragColor=texel;gl_FragDepth=unpackRGBAToDepth(texel);}',
    blending: THREE.NoBlending, side: THREE.DoubleSide,
  })
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  geometry.setDrawRange(0, 0)
  const restore = new THREE.Mesh(geometry, material)
  restore.name = 'static-shadow-restore'; restore.frustumCulled = false; restore.castShadow = true; restore.customDepthMaterial = material
  restore.onBeforeRender = () => geometry.setDrawRange(0, 0)
  restore.onBeforeShadow = (_r, _o, _c, shadowCamera) => geometry.setDrawRange(0, ready && !baking && shadowCamera === sun.shadow.camera ? 3 : 0)
  restore.onAfterShadow = () => geometry.setDrawRange(0, 0)
  scene.add(restore)
  const records = surfaces.filter(m => m.castShadow).map(mesh => ({ mesh, before: mesh.onBeforeShadow, after: mesh.onAfterShadow, start: mesh.geometry.drawRange.start, count: mesh.geometry.drawRange.count }))
  for (const record of records) {
    record.mesh.onBeforeShadow = function(...args) {
      record.before.apply(this, args)
      if (ready && !baking && args[3] === sun.shadow.camera) this.geometry.setDrawRange(0, 0)
    }
    record.mesh.onAfterShadow = function(...args) { this.geometry.setDrawRange(record.start, record.count); record.after.apply(this, args) }
  }
  const depth = new THREE.MeshDepthMaterial()
  return {
    bake(staging: THREE.WebGLRenderTarget) {
      if (ready) return
      const override = scene.overrideMaterial
      baking = true
      try {
        scene.overrideMaterial = depth; renderer.shadowMap.enabled = true; renderer.shadowMap.needsUpdate = true
        renderer.setRenderTarget(staging); renderer.render(scene, camera)
        if (sun.shadow.map) {
          target.setSize(sun.shadow.map.width, sun.shadow.map.height); renderer.initRenderTarget(target)
          renderer.copyTextureToTexture(sun.shadow.map.texture, target.texture); ready = true
        }
      } finally { scene.overrideMaterial = override; baking = false; renderer.shadowMap.needsUpdate = true }
    },
    dispose() {
      for (const r of records) { r.mesh.onBeforeShadow = r.before; r.mesh.onAfterShadow = r.after; r.mesh.geometry.setDrawRange(r.start, r.count) }
      restore.removeFromParent(); target.dispose(); geometry.dispose(); material.dispose(); depth.dispose()
    },
  }
}
