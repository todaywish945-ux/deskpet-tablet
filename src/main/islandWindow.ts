/**
 * 灵动岛窗口：独立于平板的小窗，胶囊 ⇄ 展开卡片 ⇄ 贴边细条三种形态。
 * 参考常见灵动岛交互实现：
 * - 无边框透明、置顶、绝不抢焦点（focusable:false = WS_EX_NOACTIVATE）
 * - 胶囊高 44 全圆角、展开卡片在胶囊正下方（几何一步到位，内容动画在渲染层 180ms）
 * - 拖到屏幕边缘 40px 内自动停靠成 16px 细条；鼠标靠近滑出、离开 800ms 收回（死区复检防振荡）
 * - 几何切换用 16ms 补间（180ms ease-out-cubic），窗口比内容大一圈 INSET 留投影余量
 * - 位置持久化 island-state.json（含停靠边）
 */
import { BrowserWindow, screen, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

/** 窗口四周的绘制余量（投影/果冻形变），渲染层 DOM 同步缩进这么多 */
export const INSET = 6
export const CAPSULE_W = 288
export const CAPSULE_H = 44
/** 展开卡片内容尺寸（渲染层 CSS 与此硬编码对齐） */
export const CARD_W = 360
export const CARD_H = 236
/** 内容区距屏幕边缘的最小距离 */
const EDGE_MARGIN = 16
/** 停靠细条：厚 16px，左右停靠时长 64px；距边 40px 内松手即停靠 */
const STRIP_THICKNESS = 16
const STRIP_SIDE_LEN = 64
const DOCK_THRESHOLD = 40

export type IslandMode = 'capsule' | 'card' | 'docked'
export type DockEdge = 'top' | 'bottom' | 'left' | 'right'

let win: BrowserWindow | null = null
let mode: IslandMode = 'capsule'
let dockEdge: DockEdge | null = null

export function getIslandWindow(): BrowserWindow | null {
  return win
}

export function getIslandMode(): IslandMode {
  return mode
}

function stateFile(): string {
  return join(app.getPath('userData'), 'island-state.json')
}

const DOCKS: readonly DockEdge[] = ['top', 'bottom', 'left', 'right']

/** 读档：位置按工作区夹回，dock 边非法则弃用 */
function loadState(): { x: number; y: number; dock: DockEdge | null } {
  const fallback = (): { x: number; y: number; dock: DockEdge | null } => {
    const { workArea } = screen.getPrimaryDisplay()
    return { x: Math.round(workArea.x + (workArea.width - CAPSULE_W) / 2), y: workArea.y + 8, dock: null }
  }
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf-8')) as { x?: number; y?: number; dock?: string }
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return fallback()
    const dock = DOCKS.includes(raw.dock as DockEdge) ? (raw.dock as DockEdge) : null
    const display = screen.getDisplayMatching({ x: raw.x, y: raw.y, width: CAPSULE_W, height: CAPSULE_H })
    const wa = display.workArea
    const x = Math.min(Math.max(Math.round(raw.x), wa.x + EDGE_MARGIN), wa.x + wa.width - CAPSULE_W - EDGE_MARGIN)
    const y = Math.min(Math.max(Math.round(raw.y), wa.y + EDGE_MARGIN), wa.y + wa.height - CAPSULE_H - EDGE_MARGIN)
    return { x, y, dock }
  } catch {
    return fallback()
  }
}

function writePos(): void {
  if (!win || win.isDestroyed()) return
  try {
    const [x, y] = win.getPosition()
    writeFileSync(stateFile(), JSON.stringify({ x: x + INSET, y: y + INSET, dock: dockEdge }), 'utf-8')
  } catch {
    // 忽略
  }
}

export function createIslandWindow(): BrowserWindow {
  if (win) return win
  const pos = loadState()
  dockEdge = pos.dock
  win = new BrowserWindow({
    width: CAPSULE_W + INSET * 2,
    height: CAPSULE_H + INSET * 2,
    x: pos.x - INSET,
    y: pos.y - INSET,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    // 先前实现同款：WindowDoesNotAcceptFocus —— 点击岛绝不把焦点从当前应用抢走
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  // 页面（重）加载完成即重发当前状态：渲染层刷新/崩溃恢复后立刻知道自己在哪、停在哪条边。
  // 有停靠边时只发 dock 事件——mode=capsule 会让渲染层摘掉刚挂上的 docked 类
  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return
    if (dockEdge) {
      win.webContents.send('pet:island-dock', dockEdge)
    } else {
      win.webContents.send('pet:island-mode', mode)
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/island/index.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/island.html'))
  }
  win.on('closed', () => {
    win = null
  })
  return win
}

function clampCapsulePos(x: number, y: number): { x: number; y: number } {
  const display = screen.getDisplayMatching({ x, y, width: CAPSULE_W, height: CAPSULE_H })
  const wa = display.workArea
  return {
    x: Math.min(Math.max(x, wa.x + EDGE_MARGIN - INSET), wa.x + wa.width - CAPSULE_W - EDGE_MARGIN - INSET),
    y: Math.min(Math.max(y, wa.y + EDGE_MARGIN - INSET), wa.y + wa.height - CAPSULE_H - EDGE_MARGIN - INSET)
  }
}

function clampPos(): { x: number; y: number } {
  const [x, y] = win!.getPosition()
  return clampCapsulePos(x, y)
}

// ---------- 几何补间（先前实现 _animate_to：180ms ease-out-cubic，16ms 步进） ----------
let animTimer: ReturnType<typeof setInterval> | null = null

function stopAnim(): void {
  if (animTimer) {
    clearInterval(animTimer)
    animTimer = null
  }
}

function animateTo(target: Electron.Rectangle): void {
  if (!win || win.isDestroyed()) return
  stopAnim()
  const start = win.getBounds()
  const t0 = Date.now()
  const D = 180
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopAnim()
    const k = Math.min(1, (Date.now() - t0) / D)
    const e = 1 - Math.pow(1 - k, 3)
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e)
    })
    if (k >= 1) stopAnim()
  }, 16)
}

// ---------- 停靠细条 ----------

/** 细条窗口矩形：贴工作区边缘（内容边恰好压在屏边上），沿边位置跟随当前胶囊 */
function stripRect(edge: DockEdge): Electron.Rectangle {
  const [x, y] = win!.getPosition()
  const display = screen.getDisplayMatching({ x, y, width: CAPSULE_W, height: CAPSULE_H })
  const wa = display.workArea
  if (edge === 'top' || edge === 'bottom') {
    const cx = x + INSET + CAPSULE_W / 2
    const nx = Math.min(
      Math.max(Math.round(cx - CAPSULE_W / 2 - INSET), wa.x + EDGE_MARGIN - INSET),
      wa.x + wa.width - CAPSULE_W - EDGE_MARGIN - INSET
    )
    return {
      x: nx,
      y: edge === 'top' ? wa.y - INSET : wa.y + wa.height - STRIP_THICKNESS - INSET,
      width: CAPSULE_W + INSET * 2,
      height: STRIP_THICKNESS + INSET * 2
    }
  }
  const cy = y + INSET + CAPSULE_H / 2
  const ny = Math.min(
    Math.max(Math.round(cy - STRIP_SIDE_LEN / 2 - INSET), wa.y + EDGE_MARGIN - INSET),
    wa.y + wa.height - STRIP_SIDE_LEN - EDGE_MARGIN - INSET
  )
  return {
    x: edge === 'left' ? wa.x - INSET : wa.x + wa.width - STRIP_THICKNESS - INSET,
    y: ny,
    width: STRIP_THICKNESS + INSET * 2,
    height: STRIP_SIDE_LEN + INSET * 2
  }
}

/** 从停靠边滑出后的胶囊位置：贴着那条边 */
function peekRect(edge: DockEdge): Electron.Rectangle {
  const [x, y] = win!.getPosition()
  const display = screen.getDisplayMatching({ x, y, width: CAPSULE_W, height: CAPSULE_H })
  const wa = display.workArea
  if (edge === 'top' || edge === 'bottom') {
    const cx = x + INSET + CAPSULE_W / 2
    const nx = Math.min(
      Math.max(Math.round(cx - CAPSULE_W / 2 - INSET), wa.x + EDGE_MARGIN - INSET),
      wa.x + wa.width - CAPSULE_W - EDGE_MARGIN - INSET
    )
    return {
      x: nx,
      y: edge === 'top' ? wa.y - INSET : wa.y + wa.height - CAPSULE_H - INSET,
      width: CAPSULE_W + INSET * 2,
      height: CAPSULE_H + INSET * 2
    }
  }
  const cy = y + INSET + CAPSULE_H / 2
  const ny = Math.min(
    Math.max(Math.round(cy - CAPSULE_H / 2 - INSET), wa.y + EDGE_MARGIN - INSET),
    wa.y + wa.height - CAPSULE_H - EDGE_MARGIN - INSET
  )
  return {
    x: edge === 'left' ? wa.x - INSET : wa.x + wa.width - CAPSULE_W - INSET,
    y: ny,
    width: CAPSULE_W + INSET * 2,
    height: CAPSULE_H + INSET * 2
  }
}

function dockTo(edge: DockEdge): void {
  if (!win || win.isDestroyed()) return
  cancelRetreat()
  clearPeekWatchdog()
  stopAnim()
  mode = 'docked'
  dockEdge = edge
  win.setBounds(stripRect(edge))
  setDockPassthrough(true) // 停靠时点击全穿透：绝不挡下层应用（浏览器标签等）
  win.webContents.send('pet:island-dock', edge)
  if (!win.isVisible()) win.showInactive()
  writePos()
}

/** 停靠态点击穿透开关。on=true：点击全落到下层应用，鼠标移动仍转发给渲染层做悬停检测 */
export function setDockPassthrough(on: boolean): void {
  if (!win || win.isDestroyed()) return
  if (on) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(false)
}

/** 停靠细条 → 滑出胶囊（渲染层悬停 300ms 后调用）。光标不在细条上则拒绝（快速扫过不误触发） */
export function peekIsland(): void {
  if (!win || win.isDestroyed() || mode !== 'docked' || !dockEdge) return
  // 光标必须真的悬在细条带上（厚度+4px 余量）：挡住"路过"的调用
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = win.getPosition()
  const display = screen.getDisplayMatching({ x, y, width: CAPSULE_W, height: CAPSULE_H })
  const wa = display.workArea
  const inBand =
    dockEdge === 'top'
      ? cursor.y <= wa.y + STRIP_THICKNESS + 4
      : dockEdge === 'bottom'
        ? cursor.y >= wa.y + wa.height - STRIP_THICKNESS - 4
        : dockEdge === 'left'
          ? cursor.x <= wa.x + STRIP_THICKNESS + 4
          : cursor.x >= wa.x + wa.width - STRIP_THICKNESS - 4
  if (!inBand) return
  cancelRetreat()
  stopAnim()
  mode = 'capsule'
  setDockPassthrough(false)
  animateTo(peekRect(dockEdge))
  win.webContents.send('pet:island-mode', 'capsule')
  armPeekWatchdog()
}

/**
 * 滑出后的收回看门狗：不依赖渲染层 mouseleave（光标在展开动画期间离开窗口时
 * 该事件可能不触发，胶囊会一直摊在边上挡点击）。每 350ms 查光标，离开滑出的
 * 胶囊范围（窗口±6px）立即收回细条。
 */
let peekWatchdog: NodeJS.Timeout | null = null

function armPeekWatchdog(): void {
  clearPeekWatchdog()
  peekWatchdog = setInterval(() => {
    if (!win || win.isDestroyed() || mode !== 'capsule' || !dockEdge) {
      clearPeekWatchdog()
      return
    }
    const cursor = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    const M = 6
    const inside =
      cursor.x >= x - M &&
      cursor.x <= x + CAPSULE_W + INSET + M &&
      cursor.y >= y - M &&
      cursor.y <= y + CAPSULE_H + INSET + M
    if (!inside) dockTo(dockEdge) // dockTo 内部会清看门狗
  }, 350)
}

function clearPeekWatchdog(): void {
  if (peekWatchdog) {
    clearInterval(peekWatchdog)
    peekWatchdog = null
  }
}

/** 滑出后鼠标离开：800ms 后收回细条（死区复检：光标还悬在胶囊上就取消，防振荡） */
let retreatTimer: NodeJS.Timeout | null = null

export function retreatIsland(): void {
  if (!win || win.isDestroyed() || mode !== 'capsule' || !dockEdge) return
  if (retreatTimer) clearTimeout(retreatTimer)
  retreatTimer = setTimeout(() => {
    retreatTimer = null
    if (!win || win.isDestroyed() || mode !== 'capsule' || !dockEdge) return
    const cursor = screen.getCursorScreenPoint()
    const [x, y] = win.getPosition()
    if (
      cursor.x >= x - 12 &&
      cursor.x <= x + CAPSULE_W + INSET + 12 &&
      cursor.y >= y - 12 &&
      cursor.y <= y + CAPSULE_H + INSET + 12
    ) {
      return
    }
    dockTo(dockEdge)
  }, 800)
}

function cancelRetreat(): void {
  if (retreatTimer) {
    clearTimeout(retreatTimer)
    retreatTimer = null
  }
}

// ---------- 胶囊 / 卡片 ----------

/** 以胶囊形态显示（不抢焦点）；有停靠边则直接亮细条 */
export function showCapsule(): void {
  if (!win || win.isDestroyed()) return
  if (dockEdge) {
    dockTo(dockEdge)
    return
  }
  mode = 'capsule'
  const pos = clampPos()
  win.setBounds({ ...pos, width: CAPSULE_W + INSET * 2, height: CAPSULE_H + INSET * 2 })
  win.webContents.send('pet:island-mode', 'capsule')
  if (!win.isVisible()) win.showInactive()
}

/** 展开卡片：窗口先放大（多余区域透明），内容动画由渲染层播 */
export function expandCard(): void {
  if (!win || win.isDestroyed()) return
  cancelRetreat()
  clearPeekWatchdog()
  stopAnim()
  mode = 'card'
  const [x, y] = win.getPosition()
  const contentCx = x + INSET + CAPSULE_W / 2
  const display = screen.getDisplayMatching({ x, y, width: CAPSULE_W, height: CAPSULE_H })
  const wa = display.workArea
  const nx = Math.min(
    Math.max(Math.round(contentCx - CARD_W / 2 - INSET), wa.x + EDGE_MARGIN - INSET),
    wa.x + wa.width - CARD_W - EDGE_MARGIN - INSET
  )
  win.setBounds({ x: nx, y, width: CARD_W + INSET * 2, height: CARD_H + INSET * 2 })
  win.webContents.send('pet:island-mode', 'card')
  if (!win.isVisible()) win.showInactive()
}

/** 渲染层卡片收起动画播完后调用：有停靠边回细条，否则缩回胶囊 */
export function collapseToCapsule(): void {
  if (!win || win.isDestroyed()) return
  if (dockEdge) {
    dockTo(dockEdge)
    return
  }
  mode = 'capsule'
  const [x, y] = win.getPosition()
  const contentCx = x + INSET + CARD_W / 2
  const nx = Math.round(contentCx - CAPSULE_W / 2 - INSET)
  win.setBounds({ x: nx, y, width: CAPSULE_W + INSET * 2, height: CAPSULE_H + INSET * 2 })
  win.webContents.send('pet:island-mode', 'capsule')
}

export function hideIsland(): void {
  clearPeekWatchdog()
  mode = dockEdge ? 'docked' : 'capsule'
  win?.hide()
}

export function isIslandVisible(): boolean {
  return !!(win && !win.isDestroyed() && win.isVisible())
}

// ---------- 拖动（与平板同款：渲染层报起点，主进程 16ms 轮询光标） ----------
let dragTimer: NodeJS.Timeout | null = null
let dragOffset = { x: 0, y: 0 }

function cancelDragTimer(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}

export function startIslandDrag(offsetX: number, offsetY: number): void {
  const w = win
  if (!w || w.isDestroyed()) return
  cancelRetreat()
  stopAnim()
  cancelDragTimer() // 只清场，不走停靠判定
  if (mode === 'card') collapseToCapsule() // 拖动只在胶囊态：卡片先收回
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = w.getPosition()
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
  dragTimer = setInterval(() => {
    const current = win
    if (!current || current.isDestroyed()) {
      stopIslandDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    // 缩放屏下 setPosition 换算有损：每帧 setBounds 钉死尺寸（同平板拖动的教训）
    current.setBounds({
      x: Math.round(point.x - dragOffset.x),
      y: Math.round(point.y - dragOffset.y),
      width: CAPSULE_W + INSET * 2,
      height: CAPSULE_H + INSET * 2
    })
  }, 16)
}

export function stopIslandDrag(): void {
  if (!dragTimer) return // 没在拖：什么都不做
  cancelDragTimer()
  if (!win || win.isDestroyed()) return
  // 先前实现规则：松手按光标位置判停靠——距任一边 40px 内直接停靠成细条
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayMatching({ x: cursor.x, y: cursor.y, width: 1, height: 1 })
  const wa = display.workArea
  const dists: [DockEdge, number][] = [
    ['left', cursor.x - wa.x],
    ['right', wa.x + wa.width - cursor.x],
    ['top', cursor.y - wa.y],
    ['bottom', wa.y + wa.height - cursor.y]
  ]
  dists.sort((a, b) => a[1] - b[1])
  if (dists[0][1] < DOCK_THRESHOLD) {
    dockTo(dists[0][0])
    return
  }
    // 离边远：解除停靠，落为普通胶囊
    if (dockEdge) {
      dockEdge = null
      win.webContents.send('pet:island-dock', null)
    }
    clearPeekWatchdog()
    setDockPassthrough(false)
    mode = 'capsule'
    writePos()
}

app.once('before-quit', () => {
  if (dragTimer) stopIslandDrag()
  else writePos()
})
