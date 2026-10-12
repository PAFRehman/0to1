/** Keep one complete frame in flight. Zero-timeout checks never block the browser thread. */
export function createGpuPacer(gl: WebGL2RenderingContext, completed: (milliseconds: number) => void) {
  let fence: WebGLSync | null = null, started = 0, supported = true, disposed = false
  const release = () => { if (fence) gl.deleteSync(fence); fence = null }
  return {
    ready() {
      if (!fence || disposed) return true
      const result = gl.clientWaitSync(fence, 0, 0)
      if (result === gl.TIMEOUT_EXPIRED) return false
      release()
      if (result === gl.WAIT_FAILED) supported = false
      else completed(performance.now() - started)
      return true
    },
    submit(began: number) {
      if (!supported || disposed || gl.isContextLost()) return
      release(); started = began
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (!fence) { supported = false; return }
      gl.flush()
    },
    dispose() { disposed = true; release() },
  }
}
