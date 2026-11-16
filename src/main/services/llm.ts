import { ChatMessage, LLMConfig } from '../../shared/types'
import { readFileSync } from 'fs'
import { join } from 'path'

/** 从素材目录读取人设提示词 */
export function systemPrompt(assetRoot: string): string {
  return readFileSync(join(assetRoot, 'prompts', 'character.md'), 'utf-8')
}

export interface ChatStreamOptions {
  config: LLMConfig
  system: string
  history: ChatMessage[]
  signal?: AbortSignal
  /** 采样温度：闲聊 0.8（默认），记忆提取这类结构化任务调低 */
  temperature?: number
  onDelta: (text: string) => void
}

/** 连接 + 首字节超时（ms） */
const CONNECT_TIMEOUT_MS = 30_000
/** 流空闲超时：两次数据之间隔这么久没有任何新内容就掐断（覆盖服务端出首字前的思考间隙） */
const STREAM_IDLE_TIMEOUT_MS = 60_000

/**
 * 调用 OpenAI 兼容接口（默认 DeepSeek）流式补全。
 * 返回完整回复文本；网络或接口错误直接抛出，由调用方提示。
 *
 * 带看门狗：连接挂起或流中途停滞（服务器不断开也不发数据）时主动掐断，
 * 否则 fetch / reader.read() 永远挂住，本轮走不到收尾、tts-end 发不出去，她会一直"正在说话"。
 */
export async function streamChat(options: ChatStreamOptions): Promise<string> {
  const { config, system, history, signal, temperature, onDelta } = options
  const base = config.baseUrl.replace(/\/+$/, '')

  // 看门狗按"尝试"重建：AbortController 一旦 abort 就永久作废，重试必须换新的
  let watchdog = new AbortController()
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  const abortFromTurn = (): void => watchdog.abort()
  signal?.addEventListener('abort', abortFromTurn, { once: true })
  const arm = (ms: number): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => watchdog.abort(), ms)
  }

  /** 本轮是否已经吐出过正文：出过字的停滞无法安全整轮重发（正文会重复），只有没出过字才能重试 */
  let gotContent = false
  const onDeltaTracked = (text: string): void => {
    gotContent = true
    onDelta(text)
  }

  try {
    const payload = JSON.stringify({
      model: config.model,
      stream: true,
      temperature: temperature ?? 0.8,
      // GLM 4.5+ 系默认开"深度思考"：首字前先吐几百字思考链，闲聊场景纯属拖慢（实测首字 30~55s），
      // 关掉后 0.5~2s 且情绪标签协议照常遵守；glm-4-flash（无思考代际）实测也容忍此参数。
      // 只对 glm 模型发送，避免用户把 baseUrl 指向别家 OpenAI 兼容端点时收到未知参数报 400
      ...(config.model.toLowerCase().startsWith('glm') ? { thinking: { type: 'disabled' } } : {}),
      messages: [
        { role: 'system', content: system },
        // 历史里的助手消息要把情绪标签拼回去：让模型看到一致的输出格式，才会持续遵守协议
        ...history.slice(-24).map((m) => ({
          role: m.role,
          content:
            m.role === 'assistant' && m.emotion && m.emotion !== 'neutral'
              ? `[emotion:${m.emotion}]\n${m.content}`
              : m.content
        }))
      ]
    })
    const request = (): Promise<Response> =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: watchdog.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: payload
      })

    let full = ''
    const attemptStream = async (): Promise<string> => {
      arm(CONNECT_TIMEOUT_MS)
      // 429（限流/排队，如免费模型高峰 1305）静默重试：退避后原样重发，用户无感；
      // 其余状态码（401/1113 余额类等）重试无意义，直接抛给上层提示
      let response = await request()
      for (let attempt = 0; response.status === 429 && attempt < 2; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 8000))
        arm(CONNECT_TIMEOUT_MS)
        response = await request()
      }

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new Error(`大模型接口返回 ${response.status}：${detail.slice(0, 200)}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      arm(STREAM_IDLE_TIMEOUT_MS)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm(STREAM_IDLE_TIMEOUT_MS)
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const event = JSON.parse(payload)
            const delta: string | undefined = event.choices?.[0]?.delta?.content
            if (delta) {
              full += delta
              onDeltaTracked(delta)
            }
          } catch {
            // 忽略无法解析的行（心跳、注释等）
          }
        }
      }
      return full
    }

    // 连接阶段（一个字都没收到）被看门狗掐断也是免费模型高峰的排队形态——服务器既不回
    // 状态码也不断开（实测极小请求可挂 40s+），和 429 同性质：退避后整轮重发，用户无感
    for (let attempt = 0; ; attempt++) {
      try {
        await attemptStream()
        break
      } catch (error) {
        const hungBeforeContent =
          (error as Error).name === 'AbortError' && !signal?.aborted && !gotContent
        if (hungBeforeContent && attempt < 2) {
          await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 8000))
          continue
        }
        throw error
      }
    }
    return full
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (signal?.aborted) throw new Error('已取消')
      throw new Error(
        gotContent
          ? '回复流停滞了（60 秒没有任何新内容），这轮先说到这。'
          : '连接一直没通（服务器没响应），稍后再试一次吧。'
      )
    }
    throw error
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    signal?.removeEventListener('abort', abortFromTurn)
  }
}
