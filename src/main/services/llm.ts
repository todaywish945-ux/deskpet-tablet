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

  const watchdog = new AbortController()
  const abortFromTurn = (): void => watchdog.abort()
  signal?.addEventListener('abort', abortFromTurn, { once: true })
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number): void => {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => watchdog.abort(), ms)
  }

  try {
    arm(CONNECT_TIMEOUT_MS)
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal: watchdog.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        temperature: temperature ?? 0.8,
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
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`大模型接口返回 ${response.status}：${detail.slice(0, 200)}`)
    }

    let full = ''
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
            onDelta(delta)
          }
        } catch {
          // 忽略无法解析的行（心跳、注释等）
        }
      }
    }
    return full
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      if (signal?.aborted) throw new Error('已取消')
      throw new Error('回复流停滞了（60 秒没有任何新内容），这轮先说到这。')
    }
    throw error
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer)
    signal?.removeEventListener('abort', abortFromTurn)
  }
}
