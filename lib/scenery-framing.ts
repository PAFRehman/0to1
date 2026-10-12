import type { PerspectiveCamera } from 'three'
import { CONFIG, DEG } from './coast/config.js'

/** These are the original camera poses used to render the two coastline films. */
export const SCENERY_FRAMES = {
  landscape: { width: 1520, height: 854, fov: CONFIG.camera.vfovDeg, pitch: CONFIG.camera.pitchDeg },
  portrait: { width: 720, height: 1560, fov: CONFIG.camera.vfovDeg + (1.2 - 720/1560) * 22, pitch: -25.7 },
} as const

export function frameStoryCamera(camera: PerspectiveCamera, width: number, height: number) {
  const frame = width <= 760 ? SCENERY_FRAMES.portrait : SCENERY_FRAMES.landscape
  const aspect = width / height, sourceAspect = frame.width / frame.height
  // Match the video's object-fit:cover crop exactly, including wide laptop screens.
  const visibleHeight = Math.min(1, sourceAspect / aspect)
  camera.aspect = aspect
  camera.fov = 2 * Math.atan(Math.tan(frame.fov * DEG / 2) * visibleHeight) / DEG
  camera.rotation.x = frame.pitch * DEG
  camera.userData.baseFov = camera.fov
  camera.updateProjectionMatrix(); camera.updateMatrixWorld()
}
