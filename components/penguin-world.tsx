'use client'

import { useEffect, useRef, useState } from 'react'
import type { StoryScene } from '@/lib/story'
import type { Reaction, WorldController } from '@/lib/penguin-world-engine'
import type { SiteCopy } from '@/lib/site-copy'
import LivingScenery from './living-scenery'

type Props = { scene: StoryScene; motion: boolean; together: number; reaction: Reaction; cue: number; copy: SiteCopy; onTogether: (value: number) => void; onTouch: (who: 'boy' | 'girl') => void; onReady: (ready: boolean) => void; onFlightComplete: (kind: 'kiss'|'jet') => void }

export default function PenguinWorld({ scene, motion, together, reaction, cue, copy, onTogether, onTouch, onReady, onFlightComplete }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const flowers = false
  const speech = useRef<HTMLDivElement>(null), girlMark = useRef<HTMLDivElement>(null)
  const controller = useRef<WorldController | null>(null)
  const latest = useRef({ scene, motion, flowers, together, reaction, cue, onTogether, onTouch, onReady, onFlightComplete })
  latest.current = { scene, motion, flowers, together, reaction, cue, onTogether, onTouch, onReady, onFlightComplete }
  const [status, setStatus] = useState<'loading' | 'ready' | 'fallback'>('loading')
  const [progress, setProgress] = useState(0)
  const [sceneryReady, setSceneryReady] = useState(false)
  const [engineMode, setEngineMode] = useState<'worker' | 'main'>('worker')

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    const useWorker = engineMode === 'worker' && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function'
    setStatus('loading')
    void (async () => {
      if (cancelled || !canvas.current) return
      try {
        const hooks = {

          together: (value: number) => latest.current.onTogether(value), touch: (who: 'boy' | 'girl') => latest.current.onTouch(who), finish: (kind: 'kiss' | 'jet') => latest.current.onFlightComplete(kind),
          progress: (value: number) => { if (!cancelled) setProgress(value) },
          projection: (value: import('@/lib/penguin-world-engine').ActorProjection) => {
            const boyX = `${(value.boy.x * 100).toFixed(3)}%`, boyY = `${(value.boy.y * 100).toFixed(3)}%`, girlX = `${(value.girl.x * 100).toFixed(3)}%`, girlY = `${(value.girl.y * 100).toFixed(3)}%`
            if (speech.current) { if (speech.current.style.left !== boyX) speech.current.style.left = boyX; if (speech.current.style.top !== boyY) speech.current.style.top = boyY }
            if (girlMark.current) { if (girlMark.current.style.left !== girlX) girlMark.current.style.left = girlX; if (girlMark.current.style.top !== girlY) girlMark.current.style.top = girlY }
          },
        }
        const world = useWorker
          ? await (await import('@/lib/worker-world')).createWorkerWorld(canvas.current, hooks, abort.signal, latest.current, () => { if (!cancelled) setEngineMode('main') })
          : await (await import('@/lib/penguin-world-engine')).createWorld(canvas.current, hooks, abort.signal)
        if (!useWorker) canvas.current.dataset.engineThread = 'main'
        if (cancelled) { world.dispose(); return }
        controller.current = world
        controller.current.update(latest.current)
        setStatus('ready')
      } catch (error) {
        if (!cancelled) { if (useWorker) { console.warn('Coast worker unavailable; restoring native canvas:', error); setEngineMode('main'); return } console.error('Coastal scene:', error); setStatus('fallback'); latest.current.onReady(false) }
      }
    })()
    return () => { cancelled = true; abort.abort(); controller.current?.dispose(); controller.current = null }
  }, [engineMode])

  useEffect(() => { if (sceneryReady && status !== 'loading') latest.current.onReady(status === 'ready') }, [sceneryReady, status])

  useEffect(() => { controller.current?.update({ scene, motion, flowers, together, reaction, cue }) }, [scene, motion, flowers, together, reaction, cue])


  return <div className="living-world" data-renderer={status} data-flowers={flowers} data-scenery-ready={sceneryReady}>
    <LivingScenery motion={motion} onReady={setSceneryReady} />
    {status === 'fallback' && <div className="guide-static" aria-hidden="true"><img src="/images/guide.svg" alt=""/></div>}
    <canvas key={engineMode} ref={canvas} aria-label="The moving Point Lookout coastline with Pip, one blue penguin guide. Tap Pip for help." />
    {status !== 'ready' && <>{scene === 'kiss' && <img className="fallback-flight fallback-flight-kiss" src="/images/kiss.webp" alt="" aria-hidden="true" />}{scene === 'jet' && <img className="fallback-flight fallback-flight-jet" src="/images/jet.webp" alt="" aria-hidden="true" />}</>}
    {status === 'ready' && <><div ref={speech} className="pengu-speech" data-scene={scene}><span key={`${scene}-${cue}-${flowers}`}>{reaction === 'sent' ? copy.speech.sent : reaction === 'hello' ? copy.speech.hello : copy.speech[scene]}</span></div></>}
    {(status === 'loading' || !sceneryReady) && <div className="world-loading" role="status"><span className="load-line"><i style={{ transform: `scaleX(${progress})` }} /></span><span>{copy.global.loading}</span></div>}
  </div>
}
