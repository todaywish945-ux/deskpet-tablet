/**
 * 流式 PCM 播放器：主进程按顺序推来 16bit 单声道 24kHz 的 PCM 块（base64），
 * 这里解码后排进 AudioContext 时间线无缝连播。
 */

const SAMPLE_RATE = 24000

export class PcmPlayer {
  private ctx: AudioContext | null = null
  private nextTime = 0
  private startTime = 0
  private sources = new Set<AudioBufferSourceNode>()
  private gains = new Set<GainNode>()
  private volume = 1
  /** 主输出电平分析节点：Live2D 口型驱动用 */
  private analyser: AnalyserNode | null = null
  private levelBuf: Float32Array<ArrayBuffer> | null = null

  setVolume(volume: number): void {
    this.volume = volume
    for (const gain of this.gains) gain.gain.value = volume
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      this.nextTime = 0
      // 挂总输出电平分析：gain → analyser → destination
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
      this.levelBuf = new Float32Array(this.analyser.fftSize)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  pushChunk(base64: string): void {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i)

    const view = new DataView(bytes.buffer)
    const sampleCount = Math.floor(bytes.length / 2)
    if (sampleCount === 0) return
    const samples = new Float32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = view.getInt16(i * 2, true) / 32768
    }

    const ctx = this.ensureContext()
    const buffer = ctx.createBuffer(1, sampleCount, SAMPLE_RATE)
    buffer.copyToChannel(samples, 0)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = this.volume
    source.connect(gain)
    // 目的地优先连 analyser（音量之外还有口型电平），analyser 再到扬声器
    gain.connect(this.analyser ?? ctx.destination)

    const startAt = this.nextTime > ctx.currentTime ? this.nextTime : ctx.currentTime + 0.05
    if (this.nextTime <= ctx.currentTime) this.startTime = startAt
    source.start(startAt)
    this.nextTime = startAt + buffer.duration

    this.sources.add(source)
    this.gains.add(gain)
    source.onended = () => {
      this.sources.delete(source)
      this.gains.delete(gain)
      try {
        source.disconnect()
        gain.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }

  get busy(): boolean {
    return this.remainingMs > 0
  }

  get playing(): boolean {
    return !!this.ctx && this.ctx.state === 'running' &&
      this.ctx.currentTime >= this.startTime && this.ctx.currentTime < this.nextTime
  }

  // 挂起的音频仍在队列里，不能把静止的时钟误判为播放完成。
  get remainingMs(): number {
    if (!this.ctx || this.ctx.state === 'closed') return 0
    return Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000)
  }

  /** 当前输出 RMS（0..1）：Live2D 口型开合的驱动信号。空闲返回 0 */
  level(): number {
    if (!this.analyser || !this.levelBuf || !this.busy) return 0
    this.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    for (const v of this.levelBuf) sum += v * v
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 6)
  }

  /** 立即停止并丢弃所有未播完的音频 */
  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        /* not started */
      }
    }
    this.sources.clear()
    this.gains.clear()
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close()
    }
    this.ctx = null
    this.nextTime = 0
  }
}
