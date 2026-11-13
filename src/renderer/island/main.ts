/**
 * 灵动岛渲染层：胶囊（头像+名字+时钟/她说的最新一句+状态点）⇄ 展开卡片。
 * 动效参考先前实现：弹簧物理（16ms 半隐式欧拉，静止时完全不跑）驱动果冻形变，
 * 几何由主进程 setBounds 一步到位、内容过渡在 CSS 180ms ease-out-cubic。
 */

const api = window.petAPI

const root = document.getElementById('island-root') as HTMLDivElement
const capsule = document.getElementById('capsule') as HTMLDivElement
const clockEl = document.getElementById('clock') as HTMLSpanElement
const msgEl = document.getElementById('msg') as HTMLSpanElement
const dotEl = document.getElementById('dot') as HTMLDivElement
const cardEl = document.getElementById('card') as HTMLDivElement
const ovStatusEl = document.getElementById('ov-status') as HTMLDivElement
const ovClockEl = document.getElementById('ov-clock') as HTMLDivElement
const lastMsgEl = document.getElementById('last-msg') as HTMLDivElement
const stripDotEl = document.getElementById('strip-dot') as HTMLElement

// 头像随皮肤：启动和每次配置变更都拉 skin.json 刷新（切皮肤后旧头像会一直挂着）
async function refreshSkinAvatar(): Promise<void> {
  try {
    const meta = (await (await fetch(`petasset://skin/skin.json?ts=${Date.now()}`)).json()) as { avatar?: string }
    if (!meta.avatar) return
    const url = `petasset://skin/${meta.avatar}`
    for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
      if (img.src.includes('/avatar.') || img.src.includes('avatar')) img.src = url
    }
  } catch {
    // 取不到就保持现状
  }
}
void refreshSkinAvatar()
api.on('pet:config-changed', () => {
  void refreshSkinAvatar()
})

// ---------- 时钟 ----------

const pad = (n: number): string => String(n).padStart(2, '0')

function tickClock(): void {
  const now = new Date()
  const text = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  clockEl.textContent = text
  ovClockEl.textContent = text
}
tickClock()
setInterval(tickClock, 10_000)

// ---------- 状态点 ----------

type Status = 'idle' | 'thinking' | 'speaking' | 'error'

let baseStatus: Exclude<Status, 'error'> = 'idle'
let errorUntil = 0

const STATUS_TEXT: Record<Status, string> = {
  idle: '在这里等你',
  thinking: '在想心事…',
  speaking: '在和你说话…',
  error: '刚刚断了一下'
}

function currentStatus(): Status {
  return Date.now() < errorUntil ? 'error' : baseStatus
}

function applyStatus(): void {
  const s = currentStatus()
  dotEl.className = `st-${s}`
  stripDotEl.className = `st-${s}`
  ovStatusEl.textContent = STATUS_TEXT[s]
}

const clean = (t: unknown): string =>
  String(t ?? '')
    .replace(/\[emotion[：:][a-z_]*\]?/gi, '')
    .trim()

api.on('pet:state', (state) => {
  baseStatus = state === 'thinking' ? 'thinking' : 'idle'
  applyStatus()
})
api.on('pet:tts-start', () => {
  baseStatus = 'speaking'
  applyStatus()
})
api.on('pet:tts-end', () => {
  baseStatus = 'idle'
  scheduleMsgRevert()
  applyStatus()
})
api.on('pet:tts-error', () => {
  baseStatus = 'idle'
  applyStatus()
})
api.on('pet:error', () => {
  errorUntil = Date.now() + 4000
  applyStatus()
  setTimeout(applyStatus, 4100)
})
api.on('pet:interrupt', () => {
  baseStatus = 'idle'
  scheduleMsgRevert(3000)
  applyStatus()
})

// ---------- 最近消息 + 胶囊消息模式 ----------

let msgRevertTimer: ReturnType<typeof setTimeout> | null = null

function revertToClock(): void {
  msgRevertTimer = null
  msgEl.classList.add('hidden')
  clockEl.classList.remove('hidden')
}

function scheduleMsgRevert(delay = 8000): void {
  if (msgRevertTimer) clearTimeout(msgRevertTimer)
  msgRevertTimer = setTimeout(revertToClock, delay)
}

function showMsgInCapsule(text: string): void {
  msgEl.textContent = text
  msgEl.classList.remove('hidden')
  clockEl.classList.add('hidden')
}

api.on('pet:sentence', (text) => {
  const t = clean(text)
  if (!t) return
  lastMsgEl.textContent = t
  bump()
  showMsgInCapsule(t)
  // 说话期间保持消息模式，tts-end/interrupt 统一收回复时钟
  if (msgRevertTimer) {
    clearTimeout(msgRevertTimer)
    msgRevertTimer = null
  }
})
api.on('pet:user-message', () => bump())

// ---------- 弹簧物理（半隐式欧拉 16ms；静止时循环完全停掉） ----------

class Spring {
  value: number
  vel = 0
  target: number

  constructor(
    value: number,
    target: number,
    private stiffness: number,
    private damping: number,
    private min = -Infinity,
    private max = Infinity
  ) {
    this.value = value
    this.target = target
  }

  /** 返回是否仍在运动（感知阈值判停，静止就不该再占 rAF） */
  step(dt: number): boolean {
    const a = -this.stiffness * (this.value - this.target) - this.damping * this.vel
    this.vel += a * dt
    this.value += this.vel * dt
    if (this.value < this.min) {
      this.value = this.min
      if (this.vel < 0) this.vel = 0
    }
    if (this.value > this.max) {
      this.value = this.max
      if (this.vel > 0) this.vel = 0
    }
    return Math.abs(this.value - this.target) > 0.0015 || Math.abs(this.vel) > 0.02
  }
}

const kickY = new Spring(0, 0, 210, 17, -5, 5) // 受击踢动
const squish = new Spring(1, 1, 150, 8.5, 0.85, 1.12) // 果冻压扁（横向鼓出 30%）
const hoverS = new Spring(1, 1, 170, 15, 0.97, 1.03) // 悬停放大 1.02

let rafId: number | null = null
let lastT = 0

function tick(t: number): void {
  const dt = Math.min(0.032, (t - lastT) / 1000) || 0.016
  lastT = t
  const active = [kickY.step(dt), squish.step(dt), hoverS.step(dt)].some(Boolean)
  const sy = squish.value * hoverS.value
  const sx = (1 + (1 - squish.value) * 0.3) * hoverS.value
  capsule.style.transform = `translateY(${kickY.value.toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
  rafId = active ? requestAnimationFrame(tick) : null
  if (!rafId) capsule.style.transform = ''
}

function ensureLoop(): void {
  if (rafId === null) {
    lastT = performance.now()
    rafId = requestAnimationFrame(tick)
  }
}

function bump(): void {
  kickY.vel -= 60
  squish.vel -= 3.5
  ensureLoop()
}

// ---------- 模式切换（胶囊 ⇄ 卡片 ⇄ 停靠细条） ----------

let mode: 'capsule' | 'card' = 'capsule'
/** 当前停靠边（null=未停靠）。滑出（peek）后仍是这个值，靠它知道离开时要收回 */
let docked: DockEdge | null = null

type DockEdge = 'top' | 'bottom' | 'left' | 'right'

/** 窗口尺寸是唯一真相：细条窗口必须挂着 docked 类，否则胶囊会被视口裁成半截。
 *  轴向按停靠边定：上下停靠看高度（~28px），左右停靠看宽度——只查高度会把
 *  左右细条（高 76）误判成胶囊态、每 800ms 摘一次正确的 docked 类 */
setInterval(() => {
  if (!docked) {
    // 未停靠却挂着 docked 类（事件丢失残留）：摘掉
    if (document.body.classList.contains('docked')) {
      document.body.classList.remove('docked')
      for (const e of ['top', 'bottom', 'left', 'right'] as const) {
        document.body.classList.remove(`dock-${e}`)
      }
    }
    return
  }
  const vertical = docked === 'left' || docked === 'right'
  const stripSized = vertical ? window.innerWidth < 40 : window.innerHeight < 40
  if (stripSized && !document.body.classList.contains('docked')) {
    document.body.classList.add('docked')
    document.body.classList.add(`dock-${docked}`)
  } else if (!stripSized && document.body.classList.contains('docked')) {
    // 正常由 island-mode 事件摘类；这里只兜事件丢失
    document.body.classList.remove('docked')
    document.body.classList.remove(`dock-${docked}`)
  }
}, 800)

api.on('pet:island-dock', (edge) => {
  docked = (edge as DockEdge) || null
  document.body.classList.toggle('docked', !!docked)
  for (const e of ['top', 'bottom', 'left', 'right'] as const) {
    document.body.classList.toggle(`dock-${e}`, docked === e)
  }
  if (docked) {
    // 细条态：卡片必定收起（窗口只有 16px 高/宽）
    mode = 'capsule'
    cardEl.classList.remove('open')
    cancelAutoCollapse()
    if (msgRevertTimer) {
      clearTimeout(msgRevertTimer)
      msgRevertTimer = null
    }
    revertToClock()
  }
})

api.on('pet:island-mode', (m) => {
  mode = m === 'card' ? 'card' : 'capsule'
  if (mode === 'capsule') {
    // 胶囊态：停靠类必须全部摘掉（peek 滑出/重发状态都走这里），
    // 否则 body.docked 的 CSS 会把胶囊藏住、留下被视口裁成半截的空壳
    document.body.classList.remove('docked')
    for (const e of ['top', 'bottom', 'left', 'right'] as const) {
      document.body.classList.remove(`dock-${e}`)
    }
  }
  if (mode === 'card') {
    cardEl.classList.add('open')
    startAutoCollapse()
  } else {
    cardEl.classList.remove('open')
    cancelAutoCollapse()
  }
})

function collapseCard(): void {
  if (mode !== 'card') return
  mode = 'capsule' // 先本地置位防重入；主进程缩窗后回发 capsule 再收尾
  cardEl.classList.remove('open')
  cancelAutoCollapse()
  setTimeout(() => void api.collapseApply(), 200) // 等 180ms 收起动画播完
}

// 15s 自动收起，悬停暂停（先前实现同款）
let autoTimer: ReturnType<typeof setTimeout> | null = null
let remaining = 15_000
let deadline = 0

function armAuto(): void {
  deadline = Date.now() + remaining
  autoTimer = setTimeout(collapseCard, remaining)
}
function startAutoCollapse(): void {
  remaining = 15_000
  if (autoTimer) clearTimeout(autoTimer)
  armAuto()
}
function pauseAuto(): void {
  if (autoTimer) {
    clearTimeout(autoTimer)
    autoTimer = null
    remaining = Math.max(1000, deadline - Date.now())
  }
}
function cancelAutoCollapse(): void {
  if (autoTimer) {
    clearTimeout(autoTimer)
    autoTimer = null
  }
}

root.addEventListener('mouseenter', () => {
  pauseAuto()
  if (mode === 'capsule') {
    hoverS.target = 1.02
    ensureLoop()
  }
})
root.addEventListener('mouseleave', () => {
  if (mode === 'card') resumeArm()
  if (mode === 'capsule') {
    hoverS.target = 1
    ensureLoop()
    // 从停靠边滑出后鼠标离开：让主进程 800ms 后收回细条
    if (docked) api.retreatIsland()
  }
})
function resumeArm(): void {
  if (mode === 'card' && !autoTimer) armAuto()
}

// ---------- 停靠穿透下的悬停召唤 ----------
// 停靠时窗口是点击穿透的（setIgnoreMouseEvents+forward），点击全部落到下层应用；
// 但鼠标移动仍转发到这里。光标在细条上**停留 300ms** 才滑出——
// 快速扫过去点浏览器标签完全不受影响，停下来她才出来。

let dwellTimer: ReturnType<typeof setTimeout> | null = null

document.addEventListener('mousemove', () => {
  if (!docked || mode !== 'capsule') return
  if (dwellTimer) return // 已在计时：光标继续动不重置（离开检测靠主进程校验光标位置）
  dwellTimer = setTimeout(() => {
    dwellTimer = null
    api.peekIsland()
  }, 300)
})

api.on('pet:island-dock', () => {
  if (dwellTimer) {
    clearTimeout(dwellTimer)
    dwellTimer = null
  }
})

// ---------- 交互：胶囊点击展开/收起、拖动、右键 ----------

let dragMoved = false

capsule.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  const sx = e.screenX
  const sy = e.screenY
  dragMoved = false
  const onMove = (ev: MouseEvent): void => {
    if (!dragMoved && Math.hypot(ev.screenX - sx, ev.screenY - sy) > 4) {
      dragMoved = true
      api.startIslandDrag(0, 0) // 主进程从当前光标/窗口位置自算偏移
    }
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    if (dragMoved) api.endIslandDrag()
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
})

capsule.addEventListener('click', () => {
  if (dragMoved) {
    dragMoved = false
    return
  }
  if (mode === 'capsule') api.expandCard()
  else collapseCard()
})

capsule.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  api.contextMenu()
})

document.getElementById('btn-show')?.addEventListener('click', () => void api.showTablet(false))
document.getElementById('btn-chat')?.addEventListener('click', () => void api.showTablet(true))
document.getElementById('btn-settings')?.addEventListener('click', () => void api.openSettings())

applyStatus()
