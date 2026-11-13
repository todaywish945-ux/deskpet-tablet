/**
 * DSH 实时活动快照：dsh 插件在用户用 dsh 干活时，把它的实时状态（忙闲、这轮的
 * 问题、正在跑的工具、最近工具成败）经控制桥 POST /dsh-activity 推过来。
 *
 * 背景：在 dsh 里追问会打断它当前的思考，所以"问进度"这件事改问她——她的大脑在
 * 每轮对话把 dshActivityPrompt() 拼进 system prompt，用户在平板或面板里问
 * "他在干嘛/进行到哪了/刚才为什么报错"，她就按快照讲，dsh 那边一根毫毛都不动。
 */

/** 单条工具记录（插件侧截过长度，这里再兜一次底） */
export interface DshToolEntry {
  name: string
  ok: boolean
  ms: number
}

/** 插件推来的活动快照（所有字段宽容可选，插件版本可能新旧不一） */
export interface DshActivity {
  running?: boolean
  turn?: number | null
  elapsedMs?: number
  userText?: string
  currentTool?: string
  currentToolMs?: number
  currentToolArgs?: string
  toolsDone?: number
  toolLog?: DshToolEntry[]
  lastError?: string
  lastFinishedAt?: number
  ts?: number
}

const TEXT_MAX = 200
const TOOL_LOG_MAX = 8
/** 快照多久没更新就不进提示词（dsh 关掉了/桌宠刚启动，别拿旧状态误导她） */
const STALE_MS = 30 * 60_000

let latest: (DshActivity & { ts: number }) | null = null

function clip(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** 清洗插件推来的快照：只认已知字段、截长度、修类型；不合法就丢弃 */
export function setDshActivity(raw: unknown): DshActivity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const toolLog: DshToolEntry[] = Array.isArray(body.toolLog)
    ? body.toolLog
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .slice(-TOOL_LOG_MAX)
        .map((entry) => ({
          name: clip(entry.name, 60),
          ok: Boolean(entry.ok),
          ms: Math.max(0, Math.round(num(entry.ms)))
        }))
    : []
  const snapshot: DshActivity & { ts: number } = {
    running: Boolean(body.running),
    turn: typeof body.turn === 'number' && Number.isFinite(body.turn) ? body.turn : null,
    elapsedMs: Math.max(0, Math.round(num(body.elapsedMs))),
    userText: clip(body.userText, TEXT_MAX),
    currentTool: clip(body.currentTool, 60),
    currentToolMs: Math.max(0, Math.round(num(body.currentToolMs))),
    currentToolArgs: clip(body.currentToolArgs, 120),
    toolsDone: Math.max(0, Math.round(num(body.toolsDone))),
    toolLog,
    lastError: clip(body.lastError, TEXT_MAX),
    lastFinishedAt: num(body.lastFinishedAt),
    ts: Date.now()
  }
  latest = snapshot
  return snapshot
}

export function getDshActivity(): DshActivity | null {
  return latest
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return totalSeconds + ' 秒'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

function toolMark(entry: DshToolEntry): string {
  const duration = entry.ms > 0 ? `(${formatDuration(entry.ms)})` : ''
  return `${entry.name}${entry.ok ? '' : '✗'}${duration}`
}

/**
 * 每轮对话拼进 system prompt 的 DSH 动态文案；没有新鲜快照时返回空串（不占上下文）。
 */
export function dshActivityPrompt(): string {
  const snap = latest
  if (!snap) return ''
  const now = Date.now()
  const finishedAgo = (snap.lastFinishedAt ?? 0) > 0 ? now - (snap.lastFinishedAt ?? 0) : Infinity
  if (!snap.running && (finishedAgo > STALE_MS || now - snap.ts > STALE_MS)) return ''

  const elapsedMs = snap.elapsedMs ?? 0
  const toolsDone = snap.toolsDone ?? 0
  const currentToolMs = snap.currentToolMs ?? 0
  const toolLog = snap.toolLog ?? []
  const lines: string[] = []
  if (snap.running) {
    lines.push(`- 状态：正在执行第 ${snap.turn ?? '?'} 轮任务（已进行 ${formatDuration(elapsedMs)}）`)
  } else {
    lines.push(`- 状态：当前空闲（上一轮在 ${formatDuration(finishedAgo)} 前收尾${toolsDone ? `，那一轮共跑了 ${toolsDone} 个工具` : ''}）`)
  }
  if (snap.userText) lines.push(`- 用户这轮交给它的任务：「${snap.userText}」`)
  if (snap.running && snap.currentTool) {
    const args = snap.currentToolArgs ? `，参数大致是 ${snap.currentToolArgs}` : ''
    lines.push(`- 此刻正在执行的工具：${snap.currentTool}（已 ${formatDuration(currentToolMs)}${args}）`)
  }
  if (toolLog.length > 0) {
    lines.push(`- 最近执行过的工具：${toolLog.map(toolMark).join(' → ')}`)
  }
  if (snap.lastError) lines.push(`- 最近一次出错：${snap.lastError}`)

  return (
    '\n【DSH 实时动态】用户同时在用 DSH（编码助手）干活，下面是它此刻的实时快照。' +
    '用户问"dsh 在干嘛/进行到哪了/出什么事了"时，就按这份快照用你自己的口吻讲给他听；' +
    '快照里没有的细节不要编，可以说"这个我还看不到"。\n' +
    lines.join('\n') + '\n'
  )
}
