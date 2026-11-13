import WebSocket from 'ws'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { TTSConfig } from '../../shared/types'
import { ensureGsvService } from './gsv'

const WS_BASE = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
export const SAMPLE_RATE = 24000

export class TTSError extends Error {}

interface RunOptions {
  signal?: AbortSignal
  /** 每收到一段 PCM（16bit 单声道 24kHz）回调一次 */
  onChunk: (pcm: Buffer) => void
}

/** 语音是否配置完整（按当前引擎各自判断） */
export function isTtsReady(config: TTSConfig): boolean {
  if (!config.enabled) return false
  if (config.provider === 'gptsovits') return Boolean(config.gsvRefAudio && config.gsvRefText)
  return Boolean(config.apiKey && config.voice)
}

function assertReady(config: TTSConfig): void {
  if (!config.enabled) throw new TTSError('语音合成未开启，可在设置里打开。')
  if (config.provider === 'gptsovits') {
    if (!config.gsvRefAudio) throw new TTSError('还没选择 GPT-SoVITS 参考音频，先到设置里选一段。')
    if (!config.gsvRefText) throw new TTSError('参考音频还没有填写文本内容，GPT-SoVITS 需要它来对齐音色。')
    return
  }
  if (!config.apiKey) throw new TTSError('还没有配置百炼 API Key，先到设置里填一下。')
  if (!config.voice) throw new TTSError('还没有克隆音色，先到设置里注册桌宠的音色。')
  if (!config.model) throw new TTSError('语音模型未配置。')
}

/* ------------------------------------------------------------------ */
/* 阿里云百炼 DashScope WebSocket 实时合成                              */
/* ------------------------------------------------------------------ */

function bailianPcm(config: TTSConfig, text: string, options: RunOptions): Promise<void> {
  const clean = text.trim()
  if (!clean) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const taskId = randomUUID()
    let started = false
    let settled = false
    let inputSent = false

    const ws = new WebSocket(WS_BASE, {
      headers: { Authorization: `Bearer ${config.apiKey}` }
    })

    // 空闲看门狗：连接活着但服务端卡住（不发音频也不发事件）时 promise 永不落定，整轮挂死。
    // 45s 收不到任何消息（音频帧或事件）就按失败收口
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdle = (): void => {
      if (settled) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish(new TTSError('语音服务 45 秒没有返回音频，连接停滞。')), 45_000)
    }

    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (idleTimer) clearTimeout(idleTimer)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      if (error) reject(error)
      else resolve()
    }

    const send = (action: string, payload: object): void => {
      ws.send(
        JSON.stringify({
          header: { action, task_id: taskId, streaming: 'duplex' },
          payload
        })
      )
    }

    options.signal?.addEventListener(
      'abort',
      () => {
        finish(new TTSError('已取消'))
      },
      { once: true }
    )

    ws.on('open', () => {
      armIdle()
      send('run-task', {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: config.model,
        parameters: {
          text_type: 'PlainText',
          voice: config.voice,
          format: 'pcm',
          sample_rate: SAMPLE_RATE,
          rate: Math.min(2, Math.max(0.5, config.speed || 1))
        },
        input: {}
      })
    })

    ws.on('message', (data, isBinary) => {
      armIdle() // 收到任何消息都重新计时
      if (isBinary) {
        if (started) options.onChunk(data as Buffer)
        return
      }
      let event: {
        header?: { event?: string; task_id?: string; error_code?: string; error_message?: string }
      }
      try {
        event = JSON.parse(String(data))
      } catch {
        return
      }
      const header = event.header ?? {}
      if (header.task_id && header.task_id !== taskId) return
      switch (header.event) {
        case 'task-started':
          started = true
          if (!inputSent) {
            inputSent = true
            send('continue-task', { input: { text: clean } })
            send('finish-task', { input: {} })
          }
          break
        case 'task-finished':
          finish()
          break
        case 'task-failed':
          finish(new TTSError(`语音合成失败：${header.error_code ?? ''} ${header.error_message ?? ''}`.trim()))
          break
      }
    })

    ws.on('error', (error) => {
      finish(new TTSError(`语音服务连接失败：${error.message}`))
    })
    ws.on('close', () => {
      if (!settled) finish(new TTSError('语音服务提前断开，音频不完整。'))
    })
  })
}

/* ------------------------------------------------------------------ */
/* GPT-SoVITS 本地 api_v2（http://127.0.0.1:9880/tts）                  */
/* ------------------------------------------------------------------ */

interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** data chunk 起始偏移与长度 */
  dataOffset: number
  dataLength: number
}

function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TTSError('本地语音服务返回的不是 WAV 数据。')
  }
  let pos = 12
  let info: WavInfo | null = null
  let sampleRate = 0
  let channels = 0
  let bits = 0
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      info = {
        sampleRate,
        channels,
        bitsPerSample: bits,
        dataOffset: pos + 8,
        dataLength: Math.min(size, buf.length - pos - 8)
      }
    }
    pos += 8 + size + (size % 2)
  }
  if (!info || !sampleRate || !channels) throw new TTSError('WAV 数据不完整（缺少 fmt/data 块）。')
  return info
}

/** ffmpeg 重采样为 16bit 单声道 24kHz 裸 PCM；ffmpeg 不在 PATH 时给出可操作的报错 */
function resampleTo24k(wav: Buffer, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      'pipe:1'
    ])
    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false
    // ffmpeg 偶发卡死（异常输入/管道阻塞）时兜底杀掉，别把整轮挂死
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const done = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    killTimer = setTimeout(() => {
      done(new TTSError('ffmpeg 重采样 30 秒没完成，这句音频丢弃。'))
      child.kill()
    }, 30_000)
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 2000) stderr += String(c)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        done(
          new TTSError(
            '本机没有找到 ffmpeg，GPT-SoVITS 的音频需要它转格式。安装后重启应用，或在设置里改用百炼。'
          )
        )
      } else {
        done(new TTSError(`ffmpeg 调用失败：${error.message}`))
      }
    })
    child.on('close', (code) => {
      if (code !== 0) done(new TTSError(`ffmpeg 转换失败：${stderr.trim().slice(0, 300) || 'exit ' + code}`))
      else done()
    })
    signal?.addEventListener(
      'abort',
      () => {
        child.kill()
        done(new TTSError('已取消'))
      },
      { once: true }
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end(wav)
  })
}

async function gsvPcm(config: TTSConfig, text: string, options: RunOptions): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  assertReady(config)

  const base = (config.gsvApiBase || 'http://127.0.0.1:9880').replace(/\/+$/, '')
  // 合成超时 60s（冷启动首次推理 ~16s，GPU 被其他程序抢占时更慢）。
  // 看门狗必须覆盖到"响应体全部读完"：只护 fetch 本身的话，头先到、正文卡死时
  // arrayBuffer() 会永远挂住，整轮走不到收尾，她就一直停在说话状态
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  const abortFromTurn = (): void => controller.abort()
  options.signal?.addEventListener('abort', abortFromTurn, { once: true })
  let wav: Buffer
  try {
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        text: clean,
        text_lang: config.gsvTextLang || 'zh',
        ref_audio_path: config.gsvRefAudio,
        prompt_text: config.gsvRefText,
        prompt_lang: config.gsvPromptLang || 'zh',
        text_split_method: 'cut0',
        streaming_mode: false,
        media_type: 'wav',
        speed_factor: Math.min(1.65, Math.max(0.6, config.speed || 1))
      })
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new TTSError(`本地语音服务报错（HTTP ${response.status}）：${detail.slice(0, 300)}`)
    }
    wav = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (options.signal?.aborted) throw new TTSError('已取消')
      throw new TTSError('本地语音服务 60 秒没响应（显卡被其他程序占满时会这样），先关掉大型游戏再试。')
    }
    if (error instanceof TTSError) throw error
    // 合成失败顺便拉起本地服务，下一句就能用（服务在线时不会走到这）
    void ensureGsvService(config)
    throw new TTSError(
      '本地语音服务（GPT-SoVITS）没有连上，正在自动帮你启动，约一分钟后就绪，稍后再发一句试试。'
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromTurn)
  }
  const pcm =
    wav.length > 44
      ? await ((): Promise<Buffer> => {
          const info = parseWav(wav)
          const raw = wav.subarray(info.dataOffset, info.dataOffset + info.dataLength)
          if (info.sampleRate === SAMPLE_RATE && info.channels === 1 && info.bitsPerSample === 16) {
            return Promise.resolve(raw)
          }
          return resampleTo24k(wav, options.signal)
        })()
      : Buffer.alloc(0)
  if (!pcm.length) return
  // 非流式接口一次返回整句，切成小块回放，保持与百炼一致的渐进播放行为
  const CHUNK = 8192
  for (let off = 0; off < pcm.length; off += CHUNK) {
    if (options.signal?.aborted) throw new TTSError('已取消')
    options.onChunk(pcm.subarray(off, Math.min(off + CHUNK, pcm.length)))
  }
}

/* ------------------------------------------------------------------ */

/** 按当前配置的引擎合成一句话语音，输出 16bit 单声道 24kHz PCM 流 */
export function synthesizePcm(config: TTSConfig, text: string, options: RunOptions): Promise<void> {
  assertReady(config)
  if (config.provider === 'gptsovits') return gsvPcm(config, text, options)
  return bailianPcm(config, text, options)
}

/** 供设置页试听：合成整段并拼接为 WAV Buffer */
export async function synthesizeWav(config: TTSConfig, text: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  await synthesizePcm(config, text, { onChunk: (chunk) => chunks.push(chunk) })
  return wrapWav(Buffer.concat(chunks), SAMPLE_RATE)
}

/** PCM16 单声道 → WAV 容器 */
export function wrapWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
