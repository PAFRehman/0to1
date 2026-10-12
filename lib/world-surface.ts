/** Same renderer on a DOM canvas or a transferred OffscreenCanvas. */
export type WorldSurface = HTMLCanvasElement | (OffscreenCanvas & {
  readonly clientWidth: number; readonly clientHeight: number
  dataset: Record<string, string>; style: Pick<CSSStyleDeclaration, 'cursor'>
  getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
  setPointerCapture: (id: number) => void; hasPointerCapture: (id: number) => boolean; releasePointerCapture: (id: number) => void
})
export type WorldHost = {
  pixelRatio: number; hidden: boolean
  observeResize: (callback: () => void) => () => void
  observeVisibility: (callback: () => void) => () => void
}
