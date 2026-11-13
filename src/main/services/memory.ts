import { randomUUID } from 'crypto'
import { join } from 'path'
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { LLMConfig } from '../../shared/types'
import { streamChat } from './llm'
import { loadSessions } from './store'
import { dialogueForExtraction } from './profile'

/**
 * 情景记忆（记忆升级 B 路线，自研；借鉴 surfcore 的「双卡」思路）：
 * - 衰减卡 memory.json：每场对话静默后用 LLM 压缩成 1~2 句「事后回忆」，再向量化（智谱 embedding-3）。
 *   清晰度随时间半衰（半衰期 30 天），太老的自然想不起来，半新不旧的以「模糊印象」措辞带出；
 *   超出容量的旧回忆不删除，转入全量卡存档。
 * - 全量卡 memory-full.jsonl：append-only，永不删除、永不进提示词——衰减卡里「忘了」的都在这里。
 * 每轮对话前把语义最相关、还没忘干净的旧回忆注入 system prompt——她能想起「上次你说过的那件事」。
 * 向量化失败不阻塞（该条回忆仍存在，只是不参与语义召回）。
 */

interface Episode {
  id: string
  /** 回忆发生日期 YYYY-MM-DD */
  date: string
  text: string
  /** embedding-3 向量（512 维）；缺失 = 未向量化成功 */
  vec?: number[] | null
  ts: number
  sessionId?: string
}

interface MemoryStore {
  episodes: Episode[]
}

const MAX_EPISODES = 300
const SIM_THRESHOLD = 0.38
/** 清晰度半衰期（天）：30 天前的回忆清晰度减半，90 天只剩约 1/8 */
const CLARITY_HALF_LIFE_DAYS = 30
/** 清晰度低于此值视为「忘了」：不再被想起（全量卡里仍有存档） */
const FORGET_CLARITY = 0.1
/** 清晰度低于此值按「模糊印象」的措辞注入 */
const FUZZY_CLARITY = 0.45

function memoryFile(): string {
  return join(app.getPath('userData'), 'data', 'memory.json')
}

function fullCardFile(): string {
  return join(app.getPath('userData'), 'data', 'memory-full.jsonl')
}

/** 全量卡：append-only，只存档不召回，保证被挤出衰减卡的回忆永远可查 */
function appendFullCard(entries: Episode[]): void {
  if (entries.length === 0) return
  appendFileSync(fullCardFile(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
}

/** 回忆清晰度：按记录时间距今天数半衰。纯推导值，不落盘、任何时刻可算 */
function clarityOf(episode: Episode, now: number): number {
  const days = Math.max(0, (now - episode.ts) / 86_400_000)
  return Math.pow(0.5, days / CLARITY_HALF_LIFE_DAYS)
}

function loadMemory(): MemoryStore {
  try {
    const raw = JSON.parse(readFileSync(memoryFile(), 'utf-8')) as MemoryStore
    if (Array.isArray(raw?.episodes)) return { episodes: raw.episodes }
  } catch {
    // 首次使用
  }
  return { episodes: [] }
}

function saveMemory(store: MemoryStore): void {
  writeFileSync(memoryFile(), JSON.stringify(store, null, 2), 'utf-8')
}

async function embed(llm: LLMConfig, text: string): Promise<number[] | null> {
  // 5 秒超时：召回是锦上添花，embedding 端点拥堵时绝不能卡住整轮对话
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const base = llm.baseUrl.replace(/\/+$/, '')
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      // 实测智谱忽略 dims 参数、固定返回 2048 维；维度一致即可算余弦，不传了
      body: JSON.stringify({ model: 'embedding-3', input: text }),
      signal: controller.signal
    })
    if (!response.ok) return null
    const data = (await response.json()) as { data?: { embedding?: number[] }[] }
    return data.data?.[0]?.embedding ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (!normA || !normB) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const SUMMARY_SYSTEM =
  '你是回忆整理器。把一段对话压缩成 1~2 句第三人称的「事后回忆」，聚焦：用户说了什么重要的事、发生了什么、用户的情绪状态。' +
  '不要寒暄和流水账。直接输出回忆文本，不要任何前缀或引号。'

/** 每会话的总结防抖 + 已总结到的消息数（避免重复总结同一段尾巴） */
const summaryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const summarizedUpTo = new Map<string, number>()
let summaryBusy = false
/** 容量告警去重：只在跨越新档位（80/90/100%）时提示一次 */
let capacityWarnedPct = 0

/** 对话静默后调度一次回忆压缩（chatPipeline 每轮对话后调用） */
export function scheduleSummary(sessionId: string, llm: LLMConfig): void {
  const prev = summaryTimers.get(sessionId)
  if (prev) clearTimeout(prev)
  summaryTimers.set(
    sessionId,
    setTimeout(() => {
      summaryTimers.delete(sessionId)
      void runSummary(sessionId, llm)
    }, 90_000)
  )
}

async function runSummary(sessionId: string, llm: LLMConfig): Promise<void> {
  if (summaryBusy) return // 下一轮对话会再次排期
  summaryBusy = true
  try {
    const session = loadSessions().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const seen = summarizedUpTo.get(sessionId) ?? 0
    // 新增消息太少不值得再压一条回忆
    if (session.messages.length - seen < 6) return
    const recent = session.messages.slice(-24).filter((m) => !m.hidden)
    const dialogue = dialogueForExtraction(recent)
    if (dialogue.length < 60) return

    let text = ''
    await streamChat({
      config: llm,
      system: SUMMARY_SYSTEM,
      temperature: 0.3,
      history: [{ role: 'user', content: dialogue, ts: Date.now() }],
      onDelta: (delta) => {
        text += delta
      }
    })
    text = text.replace(/^["'「『]+|["'」』]+$/g, '').trim()
    if (!text) return

    const store = loadMemory()
    const now = Date.now()
    const episode: Episode = {
      id: randomUUID().slice(0, 8),
      date: new Date().toLocaleDateString('sv-SE'),
      text: text.slice(0, 120),
      ts: now,
      sessionId
    }
    episode.vec = await embed(llm, episode.text)
    store.episodes.push(episode)
    // 挤出衰减卡的转入全量卡存档，不丢
    const overflow: Episode[] = []
    while (store.episodes.length > MAX_EPISODES) {
      const dropped = store.episodes.shift()
      if (dropped) overflow.push(dropped)
    }
    appendFullCard(overflow)
    saveMemory(store)
    const pct = Math.round((store.episodes.length / MAX_EPISODES) * 100)
    if (pct >= 80 && pct > capacityWarnedPct) {
      capacityWarnedPct = pct
      console.warn(
        `[memory] 记忆卡容量 ${pct}%（${store.episodes.length}/${MAX_EPISODES}），更早的回忆已转入全量卡存档`
      )
    }
    summarizedUpTo.set(sessionId, session.messages.length)
  } catch (error) {
    console.error('[memory]', error)
  } finally {
    summaryBusy = false
  }
}

/**
 * 每轮对话前的语义召回：把与这句话最相关的旧回忆拼进 system prompt。
 * 任何失败返回空串，绝不影响主流程。
 */
export async function recallForTurn(llm: LLMConfig, query: string, currentSessionId: string): Promise<string> {
  try {
    const store = loadMemory()
    const pool = store.episodes.filter((e) => e.sessionId !== currentSessionId)
    if (pool.length === 0) return ''

    let picked: Episode[] = []
    const now = Date.now()
    if (query) {
      const qv = await embed(llm, query)
      if (qv) {
        picked = pool
          .filter((e) => e.vec)
          .map((e) => ({ e, clarity: clarityOf(e, now), score: cosine(qv, e.vec!) }))
          // 相关性是召回门槛；清晰度只影响排序与措辞，太老的直接想不起来
          .filter((x) => x.score >= SIM_THRESHOLD && x.clarity >= FORGET_CLARITY)
          .sort((a, b) => b.score * b.clarity - a.score * a.clarity)
          .slice(0, 3)
          .map((x) => x.e)
      }
    }
    if (picked.length === 0) return ''

    const lines = picked
      .map((e) =>
        clarityOf(e, now) < FUZZY_CLARITY
          ? `（${e.date}，这段印象已有些模糊）${e.text}`
          : `（${e.date}）${e.text}`
      )
      .join('\n')
    return `\n\n【你回想起的更早的对话记忆（跨天回忆，自然带出，别机械复述，也别说"我记着"；标注了"模糊"的只当隐约印象，不确定就别说得笃定）】\n${lines}`
  } catch {
    return ''
  }
}
