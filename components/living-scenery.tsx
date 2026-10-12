'use client'

import { useEffect, useRef, useState } from 'react'
import { SCENERY_FRAMES } from '@/lib/scenery-framing'

type Props = { motion: boolean; onReady: (ready: boolean) => void }
type Format = 'mp4' | 'webm'
const media = {
  mp4: { type: 'video/mp4; codecs="avc1.42C028"', bitrate: 6_000_000 },
  webm: { type: 'video/webm; codecs="vp9"', bitrate: 8_000_000 },
}

/** Native video playback retains the real moving coastline without recreating it on a GPU. */
export default function LivingScenery({ motion, onReady }: Props) {
  const video = useRef<HTMLVideoElement>(null), latest = useRef({ motion, onReady })
  latest.current = { motion, onReady }
  const [source, setSource] = useState(''), [frameReady, setFrameReady] = useState(false)
  const format = useRef<Format>('mp4'), usedFallback = useRef(false), position = useRef(0)

  useEffect(() => {
    let cancelled = false, activeView = '', request = 0
    const element = video.current!
    const choose = async () => {
      const view = window.innerWidth <= 760 ? 'portrait' : 'landscape'
      if (activeView === view) return
      activeView = view; const selection = ++request
      position.current = element.currentTime || position.current
      setFrameReady(false); latest.current.onReady(false)
      const contentType = (type: Format) => type === 'mp4' && view === 'portrait' ? media.mp4.type.replace('42C028', '42C020') : media[type].type
      const supported = (Object.keys(media) as Format[]).filter(type => element.canPlayType(contentType(type)))
      let chosen = supported.includes('mp4') ? 'mp4' : supported[0] || 'mp4'
      if (navigator.mediaCapabilities?.decodingInfo && supported.length > 1) {
        const frame = SCENERY_FRAMES[view]
        // Prefer a native power-efficient decoder; never change scenery or remove an effect.
        const results = await Promise.race([
          Promise.all(supported.map(async type => {
            try { return { type, result: await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType: contentType(type), width: view === 'portrait' ? 540 : frame.width, height: view === 'portrait' ? 1170 : frame.height, bitrate: view === 'portrait' ? type === 'mp4' ? 3_100_000 : 2_000_000 : media[type].bitrate, framerate: 24 } }) } }
            catch { return { type, result: null } }
          })),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 400)),
        ])
        const efficient = results?.find(item => item.result?.supported && item.result.smooth && item.result.powerEfficient)
        if (efficient) chosen = efficient.type
      }
      if (cancelled || selection !== request) return
      format.current = chosen as Format; usedFallback.current = false
      setSource(`/scenery/coast-${view}.${chosen}`)
    }
    const play = () => { if (!cancelled && latest.current.motion && !document.hidden && element.readyState >= 2) { const promise = element.play(); if (promise) void promise.catch(() => { /* A browser power-saving policy may wait for a tap. */ }) } else element.pause() }
    const resize = () => { void choose() }
    void choose(); element.addEventListener('loadeddata', play)
    document.addEventListener('visibilitychange', play); window.addEventListener('pageshow', play); window.addEventListener('resize', resize)
    for (const event of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(event, play, { passive: true })
    return () => {
      cancelled = true; request++; element.pause(); element.removeEventListener('loadeddata', play)
      document.removeEventListener('visibilitychange', play); window.removeEventListener('pageshow', play); window.removeEventListener('resize', resize)
      for (const event of ['pointerdown', 'touchend', 'keydown']) window.removeEventListener(event, play)
      // Release the native decoder and network request on navigation/unmount.
      element.removeAttribute('src'); element.load()
    }
  }, [])
  useEffect(() => {
    const element = video.current
    if (!element) return
    if (!motion || document.hidden) element.pause()
    else if (element.readyState >= 2) void element.play().catch(() => {})
  }, [motion])

  return <><picture className="scenery-poster" aria-hidden="true"><source media="(max-width:760px)" srcSet="/scenery/coast-portrait.webp" /><img src="/scenery/coast-landscape.webp" alt="" fetchPriority="high" /></picture><video ref={video} className="living-scenery" src={source || undefined} data-ready={frameReady} data-scenery="original-3d-film" autoPlay muted loop playsInline preload="auto" disablePictureInPicture aria-hidden="true" tabIndex={-1}
    onLoadedMetadata={() => { const element = video.current!; if (position.current && Number.isFinite(element.duration)) { element.currentTime = position.current % element.duration; position.current = 0 } }}
    onLoadedData={() => { setFrameReady(true); latest.current.onReady(true) }}
    onError={() => {
      if (usedFallback.current || !source) { latest.current.onReady(true); return }
      usedFallback.current = true; const alternate = format.current === 'mp4' ? 'webm' : 'mp4'
      setSource(source.replace(/\.(mp4|webm)$/, `.${alternate}`))
    }}
  /></>
}
