import * as THREE from 'three'
import { CONFIG, DEG } from './coast/config.js'
import * as layout from './coast/world/layout.js'
import { createGpuPacer } from './coast/core/gpu-pacer'
import { frameStoryCamera } from './scenery-framing'
import type { WorldSurface } from './world-surface'

/** The original interactive actors, composited over a recording of their original living world.
 * No ocean FFT, cloud march, vegetation simulation, HDR screen buffers or world bakes run here.
 */
export async function createStoryStage(canvas: WorldSurface, progress: (n: number) => void, signal: AbortSignal, pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power', stencil: false })
  renderer.setClearColor(0, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  // Three's ACES implementation divides exposure by .6. This reproduces the coast's ACESFitted(c).
  renderer.toneMappingExposure = .6
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.autoUpdate = false
  const scene = new THREE.Scene(), cam = CONFIG.camera
  const camera = new THREE.PerspectiveCamera(cam.vfovDeg, 1, cam.near, cam.far)
  camera.position.fromArray(cam.position); camera.rotation.order = 'YXZ'
  camera.rotation.set(cam.pitchDeg * DEG, cam.yawDeg * DEG, cam.rollDeg * DEG)
  const direction = new THREE.Vector3().fromArray(CONFIG.sun.direction).normalize()
  const sun = new THREE.DirectionalLight(CONFIG.sun.color, CONFIG.sun.intensity * Math.PI)
  sun.castShadow = true; sun.shadow.mapSize.set(512, 512)
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 390, far: 420 })
  sun.shadow.bias = -.0004; sun.shadow.normalBias = .025
  scene.add(sun, sun.target)
  const fill = new THREE.HemisphereLight(); fill.color.setRGB(.42, .68, 1); fill.groundColor.setRGB(.12, .14, .09); fill.intensity = .15; scene.add(fill)
  const gl = renderer.getContext() as WebGL2RenderingContext
  let disposed = false, viewport = '', scale = 1, shadowSlot = -1, frameStart = 0, samples = 0, work = 0, warmFrames = 0
  let environment: THREE.WebGLRenderTarget | null = null
  // One small shadow receiver follows the actors on the original terrain height field.
  const groundGeometry = new THREE.PlaneGeometry(15, 15, 32, 32); groundGeometry.rotateX(-Math.PI/2)
  const groundMaterial = new THREE.ShadowMaterial({ color: '#15252d', opacity: .28, depthWrite: false })
  groundMaterial.onBeforeCompile = shader => {
    // Blend the finite receiver into the recorded ground; never leave a rectangular shadow edge.
    shader.vertexShader='varying vec2 vReceiverUv;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvReceiverUv=position.xz/15.+.5;')
    shader.fragmentShader='varying vec2 vReceiverUv;\n'+shader.fragmentShader.replace('#include <tonemapping_fragment>','vec2 edge=min(vReceiverUv,1.-vReceiverUv);gl_FragColor.a*=smoothstep(0.,.10,min(edge.x,edge.y));\n#include <tonemapping_fragment>')
  }
  const ground = new THREE.Mesh(groundGeometry, groundMaterial); ground.receiveShadow = true; scene.add(ground)
  let groundX = Infinity, groundZ = Infinity
  const focus = new THREE.Vector3(0, 33, -4)
  const pacer = createGpuPacer(gl, milliseconds => {
    if (++warmFrames <= 3 || milliseconds > 500) return
    work += milliseconds; samples++
    if (samples < 30) return
    const average = work/samples; canvas.dataset.gpuFrameMs = average.toFixed(1); work = samples = 0
    // Only live actor raster size adapts. Every device keeps the same film, rig and effects.
    if (average > 45 && scale > .75) { scale = Math.max(.75, scale-.1); resize() }
  })
  canvas.dataset.sceneryMode = 'filmed-original-3d'
  canvas.dataset.gpuPacing = 'one-frame'; canvas.dataset.waveSimulation = 'prerendered'; canvas.dataset.quality = 'complete'

  function resize(_still = false) {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight)
    const dpr = Math.min(pixelRatio || 1, 1.5, Math.sqrt(900_000/(w*h))) * scale
    const key = `${w}:${h}:${dpr}`; if (key === viewport) return
    viewport = key; renderer.setPixelRatio(dpr); renderer.setSize(w, h, false)
    canvas.dataset.renderScale = dpr.toFixed(2); frameStoryCamera(camera, w, h)
  }
  function dispose() {
    if (disposed) return; disposed = true
    pacer.dispose(); groundGeometry.dispose(); groundMaterial.dispose(); environment?.dispose(); sun.shadow.map?.dispose(); renderer.dispose()
  }
  try {
    progress(.15); resize()
    // The tiny RGBM panorama is the real coast's baked sky lighting, not a new approximation.
    const response = await fetch('/scenery/sky-light.png', { signal })
    if (!response.ok) throw new Error('World lighting could not load.')
    const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    const surface = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(image.width, image.height) : Object.assign(document.createElement('canvas'), { width: image.width, height: image.height })
    const context = surface.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
    context.drawImage(image, 0, 0); image.close()
    const { data, width, height } = context.getImageData(0, 0, surface.width, surface.height)
    const pixels = new Uint16Array(width*height*4)
    for (let y=0; y<height; y++) for(let x=0; x<width; x++) {
      const i=(y*width+x)*4, dest=((height-1-y)*width+x)*4, multiplier=data[i+3]/255*8
      pixels[dest]=THREE.DataUtils.toHalfFloat(data[i]/255*multiplier); pixels[dest+1]=THREE.DataUtils.toHalfFloat(data[i+1]/255*multiplier); pixels[dest+2]=THREE.DataUtils.toHalfFloat(data[i+2]/255*multiplier); pixels[dest+3]=THREE.DataUtils.toHalfFloat(1)
    }
    // Half-float linear sampling is native in WebGL2; no optional float-linear extension needed.
    const panorama = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.HalfFloatType)
    panorama.mapping = THREE.EquirectangularReflectionMapping; panorama.needsUpdate = true
    panorama.minFilter = panorama.magFilter = THREE.LinearFilter; panorama.colorSpace = THREE.LinearSRGBColorSpace
    const pmrem = new THREE.PMREMGenerator(renderer)
    environment = pmrem.fromEquirectangular(panorama); scene.environment = environment.texture
    pmrem.dispose(); panorama.dispose(); progress(.8)
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  } catch(error) { dispose(); throw error }

  return {
    scene, camera, renderer, layout, resize, dispose, software: false, frameMs: 1000/30,
    invalidate: () => { renderer.shadowMap.needsUpdate = true },
    canRender: () => pacer.ready(),
    update(t: number, _dt: number) {
      frameStart = performance.now(); renderer.info.reset(); canvas.dataset.worldTime = t.toFixed(2)
      const story = scene.getObjectByName('our-story')
      const actors = story?.children.filter(n => n.name === 'boy-pengu' || n.name === 'girl-pengu') ?? []
      if (actors.length) focus.copy(actors[0].position)
      if (actors.length === 2) focus.lerp(actors[1].position, .5)
      sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(direction, 400)
      if (Math.abs(focus.x-groundX) > .3 || Math.abs(focus.z-groundZ) > .3) {
        groundX = focus.x; groundZ = focus.z
        ground.position.set(groundX, 0, groundZ)
        const positions = groundGeometry.attributes.position
        for(let i=0; i<positions.count; i++) positions.setY(i, layout.heightAt(positions.getX(i)+groundX, positions.getZ(i)+groundZ)+.028)
        positions.needsUpdate = true; groundGeometry.computeVertexNormals(); groundGeometry.computeBoundingSphere()
      }
      const slot = Math.floor(t*12); if (slot !== shadowSlot) { shadowSlot = slot; renderer.shadowMap.needsUpdate = true }
    },
    render() {
      // The GPU already bounds actor triangles. Keep their real long sun shadows unobstructed.
      renderer.render(scene, camera)
      canvas.dataset.triangles=String(renderer.info.render.triangles); canvas.dataset.drawCalls=String(renderer.info.render.calls)
      canvas.dataset.liveScreenBuffers='0'; canvas.dataset.sceneryDrawCalls='0'; pacer.submit(frameStart)
    },
  }
}
