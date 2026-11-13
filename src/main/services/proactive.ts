import { getPetWindow } from '../petWindow'
import { loadConfig, loadSessions, newSession, saveSessions } from './store'
import { runTurn, isTurnActive } from './chatPipeline'
import { getActiveSessionId, setActiveSession } from './sessionState'
import { weeklyReviewData, getLastReviewDate, markReviewed } from './mood'

/** 今天（0 点起）有没有真实用户发言：有就不用再请安了 */
function hasUserActivityToday(startOfToday: number): boolean {
  for (const session of loadSessions().sessions) {
    if (session.messages.some((m) => m.role === 'user' && !m.hidden && m.ts >= startOfToday)) return true
  }
  return false
}

/**
 * 她主动开口：闲置关心 / 早安 / 深夜劝休息 / 心情周回顾。
 * 复用 runTurn 的 opening 隐藏消息机制——对对话管线零侵入。
 * 规则：深夜（0:00–7:30）完全静默；冷却期内不重复；平板被隐藏时不打扰。
 */

// PET_PROACTIVE_TEST=1：压短全部阈值做端到端验证
const TEST = process.env['PET_PROACTIVE_TEST'] === '1'
const IDLE_MS = TEST ? 20_000 : 90 * 60_000
const MIN_GAP_MS = TEST ? 40_000 : 90 * 60_000
const TICK_MS = TEST ? 10_000 : 60_000

let lastActivityAt = Date.now()
let lastProactiveAt = 0
let morningDate = ''
let nightDate = ''

/** 用户有任何发言时刷新活跃时间（ipc 的 pet:send 调用） */
export function noteUserActivity(): void {
  lastActivityAt = Date.now()
}

function localDate(d: Date): string {
  return d.toLocaleDateString('sv-SE')
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

function pickSessionId(): string | null {
  // 优先当前活跃会话（渲染层正开着的），否则取最近聊过的，都没有就建一个新的
  const store = loadSessions()
  const activeId = getActiveSessionId()
  if (activeId && store.sessions.some((s) => s.id === activeId)) return activeId
  const latest = [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (latest) return latest.id
  const session = newSession('')
  store.sessions.unshift(session)
  saveSessions(store)
  setActiveSession(session.id)
  return session.id
}

function fire(instruction: string): void {
  lastProactiveAt = Date.now()
  const sessionId = pickSessionId()
  if (!sessionId) return
  void runTurn({
    petWindow: getPetWindow(),
    config: loadConfig(),
    sessionId,
    opening: instruction
  })
}

function tick(): void {
  try {
    const config = loadConfig()
    if (!config.proactive.enabled) return
    const win = getPetWindow()
    if (win && !win.isVisible()) return // 用户明确藏起了平板：别出声打扰
    if (isTurnActive()) return

    const now = new Date()
    const minutes = minutesOfDay(now)
    if (minutes < 7 * 60 + 30) return // 深夜静默至 7:30
    const today = localDate(now)
    const idleMs = Date.now() - lastActivityAt

    // 早安：早上第一次露面（跨夜挂着或早上全新启动都算），且今天还没聊过天
    if (minutes < 11 * 60 && morningDate !== today) {
      const startOfToday = new Date(now).setHours(0, 0, 0, 0)
      morningDate = today
      if (lastActivityAt < startOfToday || !hasUserActivityToday(startOfToday)) {
        fire(
          `（现在是早上 ${now.getHours()} 点多，这是你今天主动发出的第一句问候。自然地道个早安，` +
            '可以顺着你记得的对方近况关心一句，轻松简短，一两句话就好。）'
        )
        return
      }
    }

    // 深夜劝休息：22:30 之后还挂着且半天没动静
    if (minutes >= 22 * 60 + 30 && nightDate !== today && idleMs >= 45 * 60_000) {
      nightDate = today
      fire(
        `（现在已经晚上 ${now.getHours()} 点 ${now.getMinutes()} 分了，对方很久没有说话。` +
          '你主动轻声提醒一句：夜深了，早点休息。温柔、简短，不要唠叨说教。）'
      )
      return
    }

    // 心情周回顾：攒够一周数据且至少间隔 7 天，挑对方闲着的时候说
    if (
      minutes >= 9 * 60 &&
      minutes < 22 * 60 &&
      idleMs >= 10 * 60_000 &&
      Date.now() - lastProactiveAt >= 30 * 60_000
    ) {
      const lastReview = getLastReviewDate()
      const gapOk = !lastReview || Date.now() - new Date(`${lastReview}T12:00:00`).getTime() >= 7 * 86_400_000
      const data = weeklyReviewData()
      if (gapOk && data) {
        markReviewed()
        const trend =
          data.lastWeekAvg != null
            ? data.lastWeekAvg > 0
              ? `上周平均 ${data.lastWeekAvg.toFixed(1)} 分，这周 ${data.thisWeekAvg.toFixed(1)} 分`
              : ''
            : ''
        const notes = data.days
          .slice(-7)
          .map((d) => `${d.date.slice(5)}：${d.score} 分，${d.note}`)
          .join('\n')
        fire(
          '（你刚回顾了对方最近一周的心情记录，想主动和对方聊聊这一周的状态。这是记录：\n' +
            `${notes}\n${trend ? trend + '\n' : ''}` +
            '用温柔自然的口吻说出你的观察和关心，肯定好的变化、心疼低落的日子，别像念报告，三四句话以内。）'
        )
        return
      }
    }

    // 闲置关心：太久没说话了，随口关心一句
    if (idleMs >= IDLE_MS && Date.now() - lastProactiveAt >= MIN_GAP_MS) {
      const hours = Math.floor(idleMs / 3_600_000)
      const idleText = hours >= 1 ? `${hours} 个小时` : `${Math.floor(idleMs / 60_000)} 分钟`
      fire(
        `（对方已经 ${idleText} 没和你说话了。你现在主动发一条消息关心一下：` +
          '结合现在的时间和你记得的对方近况，像朋友随口惦记那样自然，一两句话，别问「在吗」。）'
      )
    }
  } catch (error) {
    console.error('[proactive]', error)
  }
}

export function startProactive(): void {
  setInterval(tick, TICK_MS)
}
