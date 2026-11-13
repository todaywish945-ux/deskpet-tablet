/**
 * 灵动岛调度：闲置（失焦）后把平板收起、亮出独立的灵动岛窗口；
 * 从岛卡片「显示平板 / 开始聊天」、托盘、第二实例把平板唤回。
 *
 * 分工：本模块管"什么时候变"（计时、守卫、平板⇄岛切换）；岛窗口几何在
 * islandWindow.ts；平板收起前的守卫（录音/播报中）在平板渲染层——
 * 收起走"请求-确认"两步：pet:tablet-hide-request → tablet:hide-apply。
 * 展示平板无守卫，主进程直接切。
 */
import { BrowserWindow } from 'electron'
import { loadConfig, saveConfig } from './services/store'
import { getPetWindow } from './petWindow'
import { showCapsule, hideIsland, isIslandVisible } from './islandWindow'

/** 她忙不忙（说话/思考/摸头反应中）由 ipc.ts 注入，避免与 chatPipeline 循环依赖 */
let busyGuard: () => boolean = () => false

export function setIslandBusyGuard(fn: () => boolean): void {
  busyGuard = fn
}

let collapseTimer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null

function clearTimers(): void {
  if (collapseTimer) {
    clearTimeout(collapseTimer)
    collapseTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 收起请求被守卫拦下（她还在忙/渲染层录音中会静默拒绝）时，稍后重试一次 */
function armRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (isIslandVisible()) return // 已是岛态，不用再试
    const win = getPetWindow()
    if (win && !win.isDestroyed() && !win.isFocused()) requestTabletHide()
  }, 5000)
}

function requestTabletHide(): void {
  if (isIslandVisible()) return
  const win = getPetWindow()
  if (!win || win.isDestroyed() || !win.isVisible()) return
  if (win.isFocused()) return
  if (busyGuard()) {
    armRetry()
    return
  }
  win.webContents.send('pet:tablet-hide-request')
  armRetry()
}

/** 按配置武装闲置收起计时（blur 和唤回后复用）；开关关着就不武装 */
function armCollapseTimer(): void {
  const config = loadConfig()
  if (!config.window.island) return
  if (collapseTimer) clearTimeout(collapseTimer)
  const seconds = Math.max(3, Math.round(config.window.islandIdleSeconds || 10))
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    requestTabletHide()
  }, seconds * 1000)
}

/** 给 petWindow 挂闲置计时（createPetWindow 之后调用） */
export function initIsland(): void {
  const win = getPetWindow()
  if (!win || win.isDestroyed()) return
  win.on('blur', () => armCollapseTimer())
  win.on('focus', clearTimers)
}

/** 平板渲染层守卫通过后的落盘动作：藏平板、亮出岛 */
export function applyTabletHide(): void {
  const win = getPetWindow()
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) win.hide()
  showCapsule()
}

/** 隐藏平板并亮出岛（托盘"隐藏平板"、设置页隐藏按钮共用） */
export function hideTabletShowIsland(): void {
  clearTimers()
  applyTabletHide()
}

/** 立即收成灵动岛（菜单显式动作）：无视焦点/守卫，用户点了就是要收 */
export function collapseToIslandNow(): void {
  hideTabletShowIsland()
}

/**
 * 唤回平板：岛收起、平板出现并拿焦点。
 * 沉底模式靠"聚焦期间不沉"（pinIfBottom 的焦点豁免）保证唤回后可见，失焦自然沉回。
 */
export function showTablet(focusChat = false): void {
  clearTimers()
  hideIsland()
  const win = getPetWindow()
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) win.show()
  win.focus()
  if (focusChat) win.webContents.send('pet:island-focus-chat')
  win.webContents.send('pet:tablet-shown')
}

/** 托盘/右键"显示 / 隐藏平板"：隐藏时顺带亮岛，显示时收岛 */
export function toggleTabletVisible(): void {
  const win = getPetWindow()
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) {
    if (loadConfig().window.island) hideTabletShowIsland()
    else win.hide()
  } else {
    showTablet(false)
  }
}

/** 配置保存后调用：开关关了立即唤回平板并停掉计时 */
export function applyIslandConfig(): void {
  if (!loadConfig().window.island) {
    clearTimers()
    const win = getPetWindow()
    if (win && !win.isDestroyed() && !win.isVisible()) showTablet(false)
    else hideIsland()
  }
}

/** 托盘/右键菜单切换（闲置自动收起的开关）：翻转配置并立即生效 */
export function toggleIslandEnabled(): void {
  const config = loadConfig()
  const enabling = !config.window.island
  saveConfig({ ...config, window: { ...config.window, island: enabling } })
  if (enabling) {
    // 刚开启=想看岛：立即收起（不等失焦计时）
    collapseToIslandNow()
  } else {
    applyIslandConfig()
  }
  // 设置页/渲染层刷新显示（复用 config:save 的广播链路）
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('pet:config-changed')
  }
}
