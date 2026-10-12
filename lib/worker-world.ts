import type { WorldController, WorldHooks, WorldOptions } from './penguin-world-engine'
const sceneOptions = ({ scene, motion, together, reaction, cue, flowers }: WorldOptions): WorldOptions => ({ scene, motion, together, reaction, cue, flowers })

/** Keep geometry, shader compilation and GPU submission away from the page's input/audio thread. */
export function createWorkerWorld(canvas: HTMLCanvasElement, hooks: WorldHooks, signal: AbortSignal, options: WorldOptions, onCrash: () => void): Promise<WorldController> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./penguin-world-worker.ts', import.meta.url), { type: 'module', name: 'our-living-world' })
    let disposed = false, ready = false, width = canvas.clientWidth, height = canvas.clientHeight
    let moving = false, latestMove: unknown = null
    canvas.dataset.engineThread = 'worker'
    const post = (message: unknown) => { if (!disposed) worker.postMessage(message) }
    const sendMove = () => { if (latestMove && !moving) { const message = latestMove; latestMove = null; moving = true; post(message) } }
    const pointer = (event: PointerEvent) => {
      if (event.type === 'pointerdown') canvas.setPointerCapture(event.pointerId)
      const rect = canvas.getBoundingClientRect()
      const message = { type: 'pointer', event: event.type, clientX: event.clientX - rect.left, clientY: event.clientY - rect.top, pointerId: event.pointerId }
      if (event.type === 'pointermove') { latestMove = message; sendMove(); return }
      if (latestMove) { post(latestMove); latestMove = null }
      post(message)
      if ((event.type === 'pointerup' || event.type === 'pointercancel') && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    const visibility = () => post({ type: 'visibility', hidden: document.hidden })
    const observer = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (width !== w || height !== h) { width = w; height = h; post({ type: 'resize', width, height }) }
    })
    const dispose = () => {
      if (disposed) return
      disposed = true; observer.disconnect(); document.removeEventListener('visibilitychange', visibility)
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.removeEventListener(type, pointer as EventListener)
      signal.removeEventListener('abort', cancelled); worker.terminate()
    }
    const failed = (error: Error) => { dispose(); if (ready) onCrash(); else reject(error) }
    const cancelled = () => { dispose(); reject(new DOMException('Cancelled', 'AbortError')) }
    worker.onmessage = event => {
      if (disposed) return
      const data = event.data
      switch (data.type) {
        case 'state': for (const [key, value] of Object.entries(data.dataset)) if (canvas.dataset[key] !== value) canvas.dataset[key] = String(value); break
        case 'projection': hooks.projection(data.value); break
        case 'progress': hooks.progress(data.value); break
        case 'together': hooks.together(data.value); break
        case 'touch': hooks.touch(data.who); break
        case 'finish': hooks.finish(data.kind); break
        case 'cursor': canvas.style.cursor = data.value; break
        case 'pointerdone': moving = false; sendMove(); break
        case 'ready': ready = true; resolve({ update: next => post({ type: 'options', options: sceneOptions(next) }), dispose }); break
        case 'failed': failed(new Error(data.message)); break
      }
    }
    worker.onerror = event => { event.preventDefault(); failed(new Error(event.message || 'The renderer worker could not start.')) }
    worker.onmessageerror = () => failed(new Error('The renderer worker could not read its scene.'))
    if (signal.aborted) { cancelled(); return }
    signal.addEventListener('abort', cancelled, { once: true }); observer.observe(canvas)
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) canvas.addEventListener(type, pointer as EventListener, { passive: true })
    document.addEventListener('visibilitychange', visibility)
    try {
      const offscreen = canvas.transferControlToOffscreen()
      worker.postMessage({ type: 'init', canvas: offscreen, width, height, pixelRatio: devicePixelRatio || 1, hidden: document.hidden, options: sceneOptions(options) }, [offscreen])
    } catch (error) { failed(error instanceof Error ? error : new Error('Canvas transfer failed.')) }
  })
}
