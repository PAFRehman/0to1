import * as THREE from 'three'
import { CONFIG, DEG } from './coast/config.js'
import * as layout from './coast/world/layout.js'
import { gustAt, windSpeedAt, WIND_DIR } from './coast/core/wind.js'
import createSky from './coast/sky/sky.js'
import createTerrain from './coast/terrain/terrain.js'
import createOcean from './coast/ocean/ocean.js'
import createSpray from './coast/ocean/spray.js'
import createTrees from './coast/vegetation/trees.js'
import createShrubs from './coast/vegetation/shrubs.js'
import createGrass from './coast/vegetation/grass.js'
import createPost from './coast/post/post.js'
import { cacheTerrainLighting } from './coast/core/terrain-cache'
import { createGpuPacer } from './coast/core/gpu-pacer'
import type { WorldSurface } from './world-surface'

type Module = { update?: (t: number, dt: number) => void; dispose?: () => void }
type Progress = (value: number) => void

/** The original living coastline: FFT waves, surf, drifting clouds, spray and wind-driven plants. */
export async function createCoastalScene(canvas: WorldSurface, progress: Progress, signal: AbortSignal, pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const scene = new THREE.Scene(), cam = CONFIG.camera
  const camera = new THREE.PerspectiveCamera(cam.vfovDeg, 1, cam.near, cam.far)
  camera.position.fromArray(cam.position); camera.rotation.order = 'YXZ'
  camera.rotation.set(cam.pitchDeg * DEG, cam.yawDeg * DEG, cam.rollDeg * DEG)
  camera.userData.angVel = { yaw: 0, pitch: 0, roll: 0 }; camera.updateMatrixWorld()
  const sunDir = new THREE.Vector3().fromArray(CONFIG.sun.direction).normalize()
  const uniforms = {
    uTime: { value: 0 }, uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color(CONFIG.sun.color).multiplyScalar(CONFIG.sun.intensity) },
    uSkyZenith: { value: new THREE.Color(CONFIG.sky.zenith) }, uSkyHorizon: { value: new THREE.Color(CONFIG.sky.horizon) },
    uHazeColor: { value: new THREE.Color(CONFIG.haze.color) }, uHazeSunColor: { value: new THREE.Color(CONFIG.haze.sunColor) },
    uHazeDensity: { value: CONFIG.haze.density }, uHazeFalloff: { value: CONFIG.haze.heightFalloff },
    uWindDir: { value: new THREE.Vector2(WIND_DIR[0], WIND_DIR[1]) }, uGust: { value: gustAt(0) },
    uWindSpeed: { value: windSpeedAt(0) }, uWindAdv: { value: 0 },
  }
  const sunLight = new THREE.DirectionalLight(CONFIG.sun.color, CONFIG.sun.intensity)
  sunLight.position.copy(sunDir).multiplyScalar(400).add(new THREE.Vector3(20, 25, -50))
  sunLight.target.position.set(20, 25, -50); sunLight.castShadow = true
  Object.assign(sunLight.shadow.camera, { left: -110, right: 110, top: 90, bottom: -90, near: 50, far: 800 })
  sunLight.shadow.bias = -.0004; sunLight.shadow.normalBias = .04
  scene.add(sunLight, sunLight.target)
  const hemi = new THREE.HemisphereLight(CONFIG.sky.zenith, '#5a5a42', .9); scene.add(hemi)
  const mobile = canvas.clientWidth <= 760
  const gl = renderer.getContext() as WebGL2RenderingContext
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  const gpu = String(extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
  const software = /SwiftShader|llvmpipe|Software/i.test(gpu)
  const tier = mobile || software ? 'low' : /Intel|Iris|UHD|HD Graphics|Radeon Vega/i.test(gpu) ? 'medium' : 'high'
  const quality = { tier, software, scale: 1, maxDpr: Math.min(pixelRatio || 1, 1.35), shadowHz: software ? 4 : mobile ? 10 : 15 }
  const ctx = { THREE, renderer, scene, camera, config: CONFIG, layout, params: new URLSearchParams(software || mobile ? 'post=raw' : 'post=nograin'), capture: false, uniforms, quality, sunLight, hemiLight: hemi, wind: { gustAt, windSpeedAt, dir: WIND_DIR }, size: { width: canvas.clientWidth, height: canvas.clientHeight }, env: null, modules: {} as Record<string, Module>, progress: (_value: number) => {} }
  const modules: Module[] = []
  let post: Awaited<ReturnType<typeof createPost>> | null = null
  let terrainCache: ReturnType<typeof cacheTerrainLighting> = null
  let disposed = false, detail = 1, samples = 0, frameTotal = 0, viewportKey = '', warmFrames = 0, beganFrame = 0
  const frameMs = software ? 65 : mobile ? 40 : 32
  const pacer = createGpuPacer(gl, milliseconds => {
    // Measure completed work rather than the deliberately capped animation interval.
    // Warm-up shader compilation and lighting bakes don't represent steady render cost.
    if (++warmFrames <= 5 || milliseconds < 1) return
    frameTotal += Math.min(milliseconds, 2000); samples++
    const count = detail < 1 ? 90 : 16
    if (samples < count && !(samples >= 12 && frameTotal / samples > frameMs * 1.5)) return
    const average = frameTotal / samples; frameTotal = 0; samples = 0
    const next = average > frameMs * 1.5 ? Math.max(.70, Math.round((detail - .10) * 100) / 100) : average < frameMs * .72 ? Math.min(1, detail + .025) : detail
    canvas.dataset.gpuFrameMs = average.toFixed(1)
    if (next !== detail) { detail = next; resize() }
  })
  canvas.dataset.gpuPacing = 'one-frame'

  function dispose() {
    if (disposed) return; disposed = true
    pacer.dispose(); terrainCache?.dispose(); modules.forEach(m => m.dispose?.()); post?.dispose()
    const textures = new Set<THREE.Texture>(), geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
    scene.traverse(object => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) geometries.add(mesh.geometry)
      if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => {
        materials.add(material)
        Object.values(material).forEach(v => { if (v instanceof THREE.Texture) textures.add(v) })
        if ('uniforms' in material) Object.values((material as THREE.ShaderMaterial).uniforms).forEach(u => { if (u.value instanceof THREE.Texture) textures.add(u.value) })
      })
    })
    if (scene.environment) textures.add(scene.environment)
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose())
    sunLight.shadow.map?.dispose(); renderer.dispose()
  }
  function resize(still = false) {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight)
    const phone = w <= 760
    const budget = software ? still ? 1_200_000 : 180_000 : phone ? 650_000 : tier === 'medium' ? 1_100_000 : 1_600_000
    const dpr = Math.min(quality.maxDpr, Math.sqrt(budget / (w * h))) * (still ? 1 : detail)
    const nextKey = `${w}:${h}:${dpr}`
    if (nextKey === viewportKey) return
    viewportKey = nextKey
    canvas.dataset.renderScale = dpr.toFixed(2)
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.fov = w / h >= 1.2 ? cam.vfovDeg : Math.min(62, cam.vfovDeg + (1.2 - w / h) * 22)
    camera.rotation.x = (w <= 760 ? -25.7 : cam.pitchDeg) * DEG
    camera.userData.baseFov = camera.fov; camera.updateProjectionMatrix(); camera.updateMatrixWorld()
    ctx.size.width = w; ctx.size.height = h; post?.setSize(w, h, dpr)
    terrainCache?.invalidate()
  }
  resize()
  const creators = [['sky', createSky], ['terrain', createTerrain], ['ocean', createOcean], ['spray', createSpray], ['trees', createTrees], ['shrubs', createShrubs], ['grass', createGrass]] as const
  try {
    for (let i = 0; i < creators.length; i++) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const [name, create] = creators[i]
      ctx.progress = (v: number) => progress((i + v) / 8)
      const module = await create(ctx) as Module
      ctx.modules[name] = module; modules.push(module)
    }
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (software) sunLight.shadow.mapSize.setScalar(512)
    post = await createPost(ctx); viewportKey = ''; resize(); progress(.98)
    terrainCache = cacheTerrainLighting(scene, camera, renderer, sunLight, hemi, post.target.samples)
    canvas.dataset.landLighting = terrainCache ? 'reused' : 'native'
  } catch (error) { dispose(); throw error }
  return {
    scene, camera, renderer, layout, resize, dispose, software, frameMs,
    canRender: () => pacer.ready(),
    update(t: number, dt: number) {
      beganFrame = performance.now()
      renderer.info.reset(); canvas.dataset.worldTime = t.toFixed(2)
      uniforms.uTime.value = t % 3600; uniforms.uGust.value = gustAt(t)
      uniforms.uWindSpeed.value = windSpeedAt(t); uniforms.uWindAdv.value = CONFIG.wind.speed * t % 2000
      // Preserve the reference's framing throughout the story. No scene cuts or pans.
      camera.updateMatrixWorld(); modules.forEach(module => module.update?.(t, dt))
    },
    render() {
      terrainCache?.prepare()
      if (post) post.render(scene, camera); else renderer.render(scene, camera)
      canvas.dataset.triangles = String(renderer.info.render.triangles); canvas.dataset.drawCalls = String(renderer.info.render.calls)
      pacer.submit(beganFrame)
    },
  }
}
