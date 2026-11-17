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

/** 连接 + 首字节超时（ms）。免费模型高峰实测可挂 40s+ 才开始回：30s 会把它掐断重排，
 *  多次重试都在排队里打转，用户看到的就是"这轮没连上"。放宽到 60s 让排队有整段时间走完 */
const CONNECT_TIMEOUT_MS = 60_000
/** 首字预算：主模型 20 秒还没吐第一个字就换备用接口（仅本轮，下一轮仍用主模型） */
const PRIMARY_FIRST_TOKEN_MS = 20_000

/** 一档尝试目标：主模型 / 跨厂商备用接口 */
interface AttemptTarget {
  baseUrl: string
  apiKey: string
  model: string
  /** 首字预算：主模型 20s，兜底档 60s */
  firstByteMs: number
  /** 只有最后一档做拥堵重试 */
  maxRetries: number
}
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
    // 两档：主模型 → 备用接口（设置里配了才启用）。没配备用就只用主模型，不偷偷换模型
    const backup = config.backup
    const backupReady = !!backup && !!backup.baseUrl.trim() && !!backup.apiKey.trim() && !!backup.model.trim()
    const plan: AttemptTarget[] = [
      { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, firstByteMs: CONNECT_TIMEOUT_MS, maxRetries: 2 }
    ]
    if (backupReady) {
      plan.push({
        baseUrl: backup!.baseUrl.trim(),
        apiKey: backup!.apiKey.trim(),
        model: backup!.model.trim(),
        firstByteMs: CONNECT_TIMEOUT_MS,
        maxRetries: 2
      })
    }
    // 非最后一档（主模型）只给 20s 首字预算：没动静就换备用；没配备用时按 60s 正常等待
    for (let i = 0; i < plan.length - 1; i++) plan[i].firstByteMs = PRIMARY_FIRST_TOKEN_MS

    const messages = [
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
    const payloadFor = (model: string): string =>
      JSON.stringify({
        model,
        stream: true,
        temperature: temperature ?? 0.8,
        // GLM 4.5+ 系默认开"深度思考"：首字前先吐几百字思考链，闲聊场景纯属拖慢（实测首字 30~55s），
        // 关掉后 0.5~2s 且情绪标签协议照常遵守。只对 glm 4.5+ 发送——老代际的
        // glm-4-flash 走兜底时带未知参数有 400 风险，别家 OpenAI 兼容端点同理
        ...(/^glm/i.test(model) && /4\.[5-9]/.test(model) ? { thinking: { type: 'disabled' } } : {}),
        messages
      })

    let full = ''
    const attemptStream = async (target: AttemptTarget): Promise<string> => {
      // 看门狗必须按"尝试"重建：AbortController abort 一次就永久作废，
      // 沿用旧的重试会拿到已 abort 的 signal，fetch 立即失败（重试形同虚设）
      watchdog = new AbortController()
      const payload = payloadFor(target.model)
      const attemptBase = target.baseUrl.replace(/\/+$/, '')
      const request = (): Promise<Response> =>
        fetch(`${attemptBase}/chat/completions`, {
          method: 'POST',
          signal: watchdog.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${target.apiKey}`
          },
          body: payload
        })
      arm(target.firstByteMs)
      // 429（限流/排队，如免费模型高峰 1305）静默重试：退避后原样重发，用户无感；
      // 其余状态码（401/1113 余额类等）重试无意义，直接抛给上层提示
      let response = await request()
      for (let attempt = 0; response.status === 429 && attempt < 2; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 8000))
        arm(target.firstByteMs)
        response = await request()
      }

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        // 接口的 JSON 错误体（如火山方舟 ModelNotOpen）转成人话，别把整段 JSON 塞进气泡
        let hint = detail.slice(0, 200)
        try {
          const j = JSON.parse(detail) as { code?: string; message?: string; error?: { code?: string; message?: string } }
          const code = j.error?.code || j.code
          const message = j.error?.message || j.message
          if (message) hint = code ? `${code}：${message}` : message
        } catch {
          // 非 JSON 保留原文
        }
        // 火山方舟最常见的一种：模型没开通（告诉用户去哪里开，而不是甩一串英文）
        if (/ModelNotOpen/i.test(hint)) {
          hint = `模型未开通——去对应厂商控制台开通该模型（火山方舟：左侧「开通管理」找到它并开通，地域选北京）。${hint}`
        }
        throw new Error(`大模型接口返回 ${response.status}：${hint}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      arm(gotContent ? STREAM_IDLE_TIMEOUT_MS : target.firstByteMs)
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        arm(gotContent ? STREAM_IDLE_TIMEOUT_MS : target.firstByteMs)
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

    // 逐档尝试：主模型只给 20s 首字预算（免费模型高峰排队时别干等），没动静立刻换
    // 备用接口，兜底档沿用原来的拥堵重试；本轮换过就换过了，下一轮仍从配置的主模型开始
    let done = false
    for (let ti = 0; ti < plan.length && !done; ti++) {
      const target = plan[ti]
      const isLast = ti === plan.length - 1
      for (let attempt = 0; ; attempt++) {
        try {
          await attemptStream(target)
          done = true
          break
        } catch (error) {
          const msg = (error as Error).message || ''
          // 用户主动取消（新消息/挂断等）必须直接结束，不能换档续跑
          if (signal?.aborted || msg === '已取消') throw error
          const hungBeforeContent = (error as Error).name === 'AbortError' && !gotContent
          if (hungBeforeContent && attempt < (isLast ? target.maxRetries : 0)) {
            await new Promise((r) => setTimeout(r, attempt === 0 ? 3000 : 8000))
            continue
          }
          // 非最后一档：超时没动静、或直接报错（Key 错/模型未开通/限流）都换下一档兜底
          if (!isLast) break
          throw error
        }
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
