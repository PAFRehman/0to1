import { createWorld, type WorldController, type WorldOptions } from './penguin-world-engine'
import type { WorldHost, WorldSurface } from './world-surface'

type Input = { type: 'init'; canvas: OffscreenCanvas; width: number; height: number; pixelRatio: number; hidden: boolean; options: WorldOptions }
  | { type: 'resize'; width: number; height: number } | { type: 'visibility'; hidden: boolean }
  | { type: 'options'; options: WorldOptions } | { type: 'pointer'; event: string; clientX: number; clientY: number; pointerId: number }
  | { type: 'dispose' }
const scope = globalThis as unknown as { postMessage: (message: unknown) => void; onmessage: ((event: MessageEvent<Input>) => void) | null; close: () => void }
if (typeof requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16) as unknown as number
  globalThis.cancelAnimationFrame = id => clearTimeout(id)
}
let world: WorldController | null = null, surface: WorldSurface | null = null, width = 1, height = 1, stopped = false
let options: WorldOptions, queued = false
const abort = new AbortController(), resizeListeners = new Set<() => void>(), visibilityListeners = new Set<() => void>()
const host: WorldHost = { pixelRatio: 1, hidden: false,
  observeResize: callback => { resizeListeners.add(callback); return () => { resizeListeners.delete(callback) } },
  observeVisibility: callback => { visibilityListeners.add(callback); return () => { visibilityListeners.delete(callback) } },
}
scope.onmessage = event => {
  const data = event.data
  if (data.type === 'init') {
    width = data.width; height = data.height; options = data.options; host.hidden = data.hidden; host.pixelRatio = data.pixelRatio
    const captures = new Set<number>(), dataset: Record<string, string> = {}
    const flush = () => { queued = false; if (!stopped && surface) scope.postMessage({ type: 'state', dataset: { ...dataset, drawingWidth: String(surface.width), drawingHeight: String(surface.height) } }) }
    const style = { cursor: 'pointer' }
    Object.defineProperties(data.canvas, {
      clientWidth: { get: () => width }, clientHeight: { get: () => height },
      dataset: { value: new Proxy(dataset, { set(target, key: string, value) { target[key] = String(value); if (!queued) { queued = true; queueMicrotask(flush) } return true } }) },
      style: { value: new Proxy(style, { set(target, key: 'cursor', value) { if (target[key] !== value) { target[key] = value; scope.postMessage({ type: 'cursor', value }) } return true } }) },
      getBoundingClientRect: { value: () => ({ left: 0, top: 0, width, height }) },
      setPointerCapture: { value: (id: number) => captures.add(id) }, hasPointerCapture: { value: (id: number) => captures.has(id) }, releasePointerCapture: { value: (id: number) => captures.delete(id) },
    })
    surface = data.canvas as WorldSurface
    void createWorld(surface, {
      together: value => scope.postMessage({ type: 'together', value }), touch: who => scope.postMessage({ type: 'touch', who }),
      finish: kind => scope.postMessage({ type: 'finish', kind }), progress: value => scope.postMessage({ type: 'progress', value }),
      projection: value => scope.postMessage({ type: 'projection', value }),
    }, abort.signal, host).then(controller => {
      if (stopped) { controller.dispose(); return }
      world = controller; world.update(options); scope.postMessage({ type: 'ready' })
    }).catch(error => { if (!stopped) scope.postMessage({ type: 'failed', message: error instanceof Error ? error.message : 'Renderer unavailable' }) })
  } else if (data.type === 'options') { options = data.options; world?.update(options) }
  else if (data.type === 'resize') { width = data.width; height = data.height; resizeListeners.forEach(callback => callback()) }
  else if (data.type === 'visibility') { host.hidden = data.hidden; visibilityListeners.forEach(callback => callback()) }
  else if (data.type === 'pointer' && surface) {
    const pointer = new Event(data.event); Object.assign(pointer, { clientX: data.clientX, clientY: data.clientY, pointerId: data.pointerId }); surface.dispatchEvent(pointer)
    if (data.event === 'pointermove') scope.postMessage({ type: 'pointerdone' })
  } else if (data.type === 'dispose') { stopped = true; abort.abort(); world?.dispose(); scope.close() }
}
