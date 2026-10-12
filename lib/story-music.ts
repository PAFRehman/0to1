import type { StoryScene } from './story'

const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
type Style = 'calm' | 'quiet' | 'love'
type Voice = { source: AudioBufferSourceNode; gain: GainNode; style: Style; started: number; offset: number; duration: number }
const styleFor = (scene: StoryScene): Style => ['sorry', 'listen', 'space'].includes(scene) ? 'quiet' : ['ready', 'kiss', 'complete', 'jet', 'signature', 'closer'].includes(scene) ? 'love' : 'calm'

/** The original score, pre-rendered once. Native audio loops keep playing through busy GPU frames. */
export class StoryMusic {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private scene: StoryScene = 'arrival'
  private wanted = true
  private visible = true
  private noise: AudioBuffer | null = null
  private disposed = false
  private active: Voice | null = null
  private voices = new Set<Voice>()
  private buffers = new Map<Style, Promise<AudioBuffer>>()
  private abort = new AbortController()

  constructor(private callback: (playing: boolean) => void) {}
  setScene(scene: StoryScene) { this.scene = scene; if (this.context && this.wanted) void this.ensureTrack() }
  async play() {
    if (this.disposed) return
    this.wanted = true
    try {
      if (!this.context) {
        const Constructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Constructor) throw new Error('Audio is unavailable')
        this.context = new Constructor({ latencyHint: 'playback' })
        this.master = this.context.createGain(); this.master.gain.value = .75; this.master.connect(this.context.destination)
        const noise = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate), data = noise.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
        this.noise = noise
        this.context.onstatechange = () => { this.report(); if (this.context?.state === 'running' && this.wanted && this.visible) void this.ensureTrack() }
      }
      if (!this.visible) return
      // Resume is requested synchronously in the actual tap/click/key handler.
      const resumed = this.context.resume()
      this.master!.gain.setTargetAtTime(.75, this.context.currentTime, .12)
      void this.ensureTrack() // Download/decode even while autoplay waits for a gesture.
      this.report()
      await resumed
      if (!this.disposed && this.wanted && this.visible) await this.ensureTrack()
    } catch { if (!this.disposed) this.callback(false) }
  }
  private report() { this.callback(!this.disposed && this.visible && this.wanted && this.context?.state === 'running' && !!this.active) }
  private load(style: Style): Promise<AudioBuffer> {
    const cached = this.buffers.get(style); if (cached) return cached
    const request = fetch(`/audio/${style}.mp3`, { signal: this.abort.signal }).then(async response => {
      if (!response.ok) throw new Error('Score unavailable')
      return this.context!.decodeAudioData(await response.arrayBuffer())
    }).catch(error => { this.buffers.delete(style); throw error })
    this.buffers.set(style, request); return request
  }
  private async ensureTrack() {
    const context = this.context, style = styleFor(this.scene)
    if (!context || this.disposed) return
    try {
      const buffer = await this.load(style)
      if (this.disposed || !this.wanted || !this.visible || context.state !== 'running') return
      if (style !== styleFor(this.scene)) { void this.ensureTrack(); return }
      if (this.active?.style === style) { this.report(); return }
      const now = context.currentTime, previous = this.active
      const phase = previous ? ((now - previous.started + previous.offset) / previous.duration) % 1 : 0
      const source = context.createBufferSource(), gain = context.createGain()
      source.buffer = buffer; source.loop = true
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + (previous ? .85 : .16))
      source.connect(gain).connect(this.master!); const offset = Math.max(0, phase) * buffer.duration
      const voice = { source, gain, style, started: now, offset, duration: buffer.duration }
      this.voices.add(voice); this.active = voice
      source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(voice); if (this.active?.style !== style && styleFor(this.scene) !== style) this.buffers.delete(style) }
      source.start(now, offset)
      if (previous) { previous.gain.gain.cancelScheduledValues(now); previous.gain.gain.setValueAtTime(previous.gain.gain.value, now); previous.gain.gain.linearRampToValueAtTime(0, now + .85); previous.source.stop(now + .9) }
      this.report()
    } catch { if (!this.active) this.report() }
  }
  mute() { this.wanted = false; if (this.master && this.context) { this.master.gain.setTargetAtTime(0, this.context.currentTime, .04); void this.context.suspend().catch(() => {}) } this.callback(false) }
  visibility(visible: boolean) {
    this.visible = visible
    if (!visible) { if (this.context) void this.context.suspend().catch(() => {}); this.callback(false) }
    else if (this.wanted) void this.play()
  }
  private note(midi: number, at: number, duration: number, volume: number, glass = false) {
    const c = this.context!; const envelope = c.createGain()
    envelope.gain.setValueAtTime(.0001, at); envelope.gain.exponentialRampToValueAtTime(volume, at + .016)
    envelope.gain.exponentialRampToValueAtTime(.0001, at + duration)
    const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = glass ? 3200 : 1100
    envelope.connect(filter).connect(this.master!)
    const partials = glass ? [[1, 1], [2.001, .18], [3.98, .03]] : [[1, 1], [2, .25], [3, .075]]
    let ended = 0
    partials.forEach(([multiple, strength]) => {
      const osc = c.createOscillator(), gain = c.createGain(); osc.type = 'sine'; osc.frequency.value = frequency(midi) * multiple; gain.gain.value = strength
      osc.connect(gain).connect(envelope); osc.start(at); osc.stop(at + duration + .05)
      osc.onended = () => { osc.disconnect(); gain.disconnect(); if (++ended === partials.length) { envelope.disconnect(); filter.disconnect() } }
    })
  }
  chime() { if (!this.context || this.context.state !== 'running' || !this.wanted) return; [74, 78, 81].forEach((n, i) => this.note(n, this.context!.currentTime + i * .1, 1.5, .025, true)) }
  flight(kind: 'kiss' | 'jet') {
    if (!this.context || this.context.state !== 'running' || !this.wanted || !this.noise) return
    const c = this.context, src = c.createBufferSource(), gain = c.createGain(), filter = c.createBiquadFilter(), duration = kind === 'jet' ? 2.6 : 2.8
    src.buffer = this.noise; src.loop = true; filter.type = 'lowpass'; filter.frequency.value = 180
    filter.frequency.exponentialRampToValueAtTime(kind === 'jet' ? 1700 : 750, c.currentTime + duration * .6)
    gain.gain.setValueAtTime(.0001, c.currentTime); gain.gain.exponentialRampToValueAtTime(kind === 'jet' ? .06 : .025, c.currentTime + duration * .5); gain.gain.exponentialRampToValueAtTime(.0001, c.currentTime + duration)
    src.connect(filter).connect(gain).connect(this.master!); src.start(); src.stop(c.currentTime + duration + .05)
    src.onended = () => { src.disconnect(); gain.disconnect(); filter.disconnect() }
  }
  dispose() {
    this.disposed = true; this.abort.abort()
    for (const voice of this.voices) { voice.source.onended = null; try { voice.source.stop() } catch { /* A fade may already have ended. */ } voice.source.disconnect(); voice.gain.disconnect() }
    this.voices.clear(); this.active = null; this.buffers.clear(); this.master?.disconnect()
    if (this.context) { this.context.onstatechange = null; void this.context.close().catch(() => {}) }
  }
}
