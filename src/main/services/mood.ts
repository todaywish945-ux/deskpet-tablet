import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { LLMConfig } from '../../shared/types'
import { streamChat } from './llm'
import { loadSessions } from './store'

/**
 * 心情记录：每天用一次 LLM 给用户当天的心情打分 + 一句话概括；
 * 攒够一周后由「主动开口」系统做一次心情周回顾。
 * 失败静默，绝不影响主流程。
 */

export interface MoodDay {
  date: string
  /** 1（很低落）~ 5（很好） */
  score: number
  note: string
}

interface MoodStore {
  days: MoodDay[]
  /** 上次做周回顾的日期 */
  lastReview?: string
}

function moodFile(): string {
  return join(app.getPath('userData'), 'data', 'mood.json')
}

function loadMood(): MoodStore {
  try {
    const raw = JSON.parse(readFileSync(moodFile(), 'utf-8')) as MoodStore
    if (Array.isArray(raw?.days)) return { days: raw.days, lastReview: raw.lastReview }
  } catch {
    // 首次使用
  }
  return { days: [] }
}

function saveMood(store: MoodStore): void {
  writeFileSync(moodFile(), JSON.stringify(store, null, 2), 'utf-8')
}

function today(): string {
  return new Date().toLocaleDateString('sv-SE')
}

const MOOD_SYSTEM =
  '你是情绪观察员。根据用户今天的对话，判断用户今天整体的心情状态。' +
  '只输出一个 JSON 对象：{"score": 1到5的整数（1=很低落，3=平静，5=很好），"note": "一句话概括今天的状态，20字内，第三人称"}。' +
  '只输出 JSON，不要解释。'

let moodTimer: ReturnType<typeof setTimeout> | null = null

/** 对话后调度当天心情更新（10 分钟防抖，一天最多覆盖同一天的记录） */
export function scheduleMoodUpdate(llm: LLMConfig): void {
  if (moodTimer) clearTimeout(moodTimer)
  moodTimer = setTimeout(() => {
    moodTimer = null
    void runMoodUpdate(llm)
  }, 10 * 60_000)
}

async function runMoodUpdate(llm: LLMConfig): Promise<void> {
  try {
    // 收集今天所有会话里的真实发言
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const lines: string[] = []
    for (const session of loadSessions().sessions) {
      for (const m of session.messages) {
        if (m.hidden || m.ts < start.getTime()) continue
        lines.push(`${m.role === 'user' ? '用户' : '桌宠'}：${m.content}`)
      }
    }
    const dialogue = lines.join('\n').slice(-3000)
    if (dialogue.length < 40) return

    let raw = ''
    await streamChat({
      config: llm,
      system: MOOD_SYSTEM,
      temperature: 0.2,
      history: [{ role: 'user', content: dialogue, ts: Date.now() }],
      onDelta: (delta) => {
        raw += delta
      }
    })
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s < 0 || e <= s) return
    const parsed = JSON.parse(raw.slice(s, e + 1)) as { score?: number; note?: string }
    const score = Math.min(5, Math.max(1, Math.round(Number(parsed.score) || 3)))
    const note = String(parsed.note ?? '').trim().slice(0, 40)
    if (!note) return

    const store = loadMood()
    const date = today()
    const existing = store.days.find((d) => d.date === date)
    if (existing) {
      existing.score = score
      existing.note = note
    } else {
      store.days.push({ date, score, note })
      while (store.days.length > 400) store.days.shift()
    }
    saveMood(store)
  } catch (error) {
    console.error('[mood]', error)
  }
}

export interface WeeklyReview {
  summary: string
}

/** 攒够一周（近 7 天 ≥5 天有记录）才生成周回顾数据；不足返回 null */
export function weeklyReviewData(): { days: MoodDay[]; thisWeekAvg: number; lastWeekAvg: number | null } | null {
  const store = loadMood()
  const now = Date.now()
  const week = store.days.filter((d) => now - new Date(`${d.date}T12:00:00`).getTime() <= 7 * 86_400_000)
  if (week.length < 5) return null
  const thisWeekAvg = week.reduce((s, d) => s + d.score, 0) / week.length
  const prev = store.days.filter((d) => {
    const age = now - new Date(`${d.date}T12:00:00`).getTime()
    return age > 7 * 86_400_000 && age <= 14 * 86_400_000
  })
  const lastWeekAvg = prev.length >= 3 ? prev.reduce((s, d) => s + d.score, 0) / prev.length : null
  return { days: week, thisWeekAvg, lastWeekAvg }
}

export function getLastReviewDate(): string | undefined {
  return loadMood().lastReview
}

export function markReviewed(): void {
  const store = loadMood()
  store.lastReview = today()
  saveMood(store)
}
