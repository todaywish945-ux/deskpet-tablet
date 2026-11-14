import { BrowserWindow, screen, Menu, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { createSettingsWindow } from './settingsWindow'
import { sendWindowToBottom } from './win32'
import { loadConfig } from './services/store'
import { pluginPort } from './services/pluginBridge'
import { petLogWS } from './services/pluginBridge'
import type { PetLayerMode } from '../shared/types'

/** 平板外框尺寸（含边框）；屏幕区 4:3 横向，与动画素材 (2880x2160) 比例一致 */
export const PET_WIDTH = 628
export const PET_HEIGHT = 484

let petWindow: BrowserWindow | null = null

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}

let layerMode: PetLayerMode = 'bottom'

function pinIfBottom(): void {
  const win = petWindow
  // 焦点豁免：从岛卡片唤回平板时窗口正持有焦点，此时沉底会把刚唤回的平板
  // 压到所有活动窗口之下；失焦后 blur 钩子自然沉回
  if (!win || win.isDestroyed() || win.isFocused()) return
  if (layerMode === 'bottom') sendWindowToBottom(win)
}

/** 按配置应用平板层级；设置里切换后实时调用 */
export function applyPetLayer(): void {
  const win = petWindow
  if (!win || win.isDestroyed()) return
  layerMode = loadConfig().window.layer === 'top' ? 'top' : 'bottom'
  if (layerMode === 'top') {
    win.setAlwaysOnTop(true, 'screen-saver')
    return
  }
  win.setAlwaysOnTop(false)
  sendWindowToBottom(win)
}

/** 记住窗口位置：拖动停稳后落盘，下次启动恢复（中心点不在任何屏幕内则回默认位） */
function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/** 中心点落在任一显示器内才算有效位置 */
function isPosOnScreen(x: number, y: number): boolean {
  const cx = x + PET_WIDTH / 2
  const cy = y + PET_HEIGHT / 2
  for (const display of screen.getAllDisplays()) {
    const b = display.bounds
    if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) return true
  }
  return false
}

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf-8')) as { x?: number; y?: number }
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number') return null
    if (!isPosOnScreen(raw.x, raw.y)) return null
    return { x: Math.round(raw.x), y: Math.round(raw.y) }
  } catch {
    // 没有记录
  }
  return null
}

function writePosition(win: BrowserWindow): void {
  try {
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    writeFileSync(stateFile(), JSON.stringify({ x: b.x, y: b.y }), 'utf-8')
  } catch {
    // 忽略
  }
}

export function createPetWindow(): BrowserWindow {
  if (petWindow) return petWindow

  const { workArea } = screen.getPrimaryDisplay()
  const saved = loadSavedPosition()
  petWindow = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: saved?.x ?? workArea.x + workArea.width - PET_WIDTH - 48,
    y: saved?.y ?? workArea.y + workArea.height - PET_HEIGHT - 96,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 桌宠常驻：隐藏/遮挡时也不节流定时器与媒体（隐藏时启动的 video 会被 Chromium 冻结）
      backgroundThrottling: false
    }
  })
  applyPetLayer()
  // 沉底模式下：显示/恢复时重新沉底；点平板会浮到普通窗口之上，失焦后立刻沉回去
  petWindow.on('show', pinIfBottom)
  petWindow.on('restore', pinIfBottom)
  petWindow.on('blur', pinIfBottom)
  petWindow.once('ready-to-show', () => petWindow?.show())
  // 最大化时整体等比缩放：UI 是固定 628×484 的绝对布局，靠缩放适配大窗
  const fitZoom = (): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    const [w, h] = petWindow.getSize()
    petWindow.webContents.setZoomFactor(Math.min(w / PET_WIDTH, h / PET_HEIGHT))
  }
  petWindow.on('resize', fitZoom)
  petWindow.webContents.setZoomFactor(1) // 清掉 Electron 按域名持久化的缩放，启动永远回到标准尺寸

  if (process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet/index.html`)
  } else if (app.isPackaged && pluginPort() > 0) {
    // 打包版从桥加载：file:// 下 navigator.mediaDevices 是 undefined（Electron 已知问题），
    // localhost 是安全上下文，麦克风代录才能在桌宠进程里工作。加载失败回退 loadFile。
    petWindow.loadURL(`http://127.0.0.1:${pluginPort()}/app/pet/index.html`)
    petWindow.webContents.on('did-fail-load', (_event, _code, _desc, url, isMain) => {
      if (isMain && url.includes('/app/pet/')) petWindow?.loadFile(join(__dirname, '../renderer/pet/index.html'))
    })
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/pet/index.html'))
  }

  // 渲染层 console → 看门狗日志：打包版 stdout 没人能看，排查远程功能全靠这个文件
  petWindow.webContents.on('console-message', (_event, _level, message) => {
    petLogWS('renderer: ' + message)
  })

  // 实测这套无边框窗口 'moved' 事件不可靠（外部/内部挪动都可能不发），
  // 落盘完全不赌事件：拖动结束（stopDrag）、关窗、退出三条确定性路径兜底
  petWindow.on('close', () => {
    if (petWindow) writePosition(petWindow)
  })
  app.once('before-quit', () => {
    if (petWindow && !petWindow.isDestroyed()) writePosition(petWindow)
  })
  petWindow.on('closed', () => {
    petWindow = null
  })
  return petWindow
}

/** 手动拖动状态：渲染层报一次起点，主进程轮询光标移动窗口（比高频 IPC 平滑） */
let dragTimer: NodeJS.Timeout | null = null
let dragOffset = { x: 0, y: 0 }

export function startDrag(offsetX: number, offsetY: number): void {
  const win = petWindow
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
  stopDrag()
  dragTimer = setInterval(() => {
    const current = petWindow
    if (!current || current.isDestroyed()) {
      stopDrag()
      return
    }
    const point = screen.getCursorScreenPoint()
    // 缩放屏（如 150%）下 setPosition 换算有损，尺寸会按帧累积成"自己拉长"；每帧用 setBounds 钉死尺寸
    current.setBounds({
      x: Math.round(point.x - dragOffset.x),
      y: Math.round(point.y - dragOffset.y),
      width: PET_WIDTH,
      height: PET_HEIGHT
    })
  }, 16)
}

export function stopDrag(): void {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
    // 拖完立刻落盘：外部 SetWindowPos 等场景下 'moved' 事件不可靠，别赌事件
    if (petWindow && !petWindow.isDestroyed()) writePosition(petWindow)
  }
}

/** 由 ipc.ts 注入灵动岛相关动作（petWindow ↔ island 不能互相 import） */
let islandToggleHandler: (() => void) | null = null
/** 右键菜单"隐藏平板"：灵动岛开着时要顺带亮出岛 */
let hideToIslandHandler: (() => void) | null = null
/** 右键菜单"立即收成灵动岛"显式动作 */
let collapseToIslandHandler: (() => void) | null = null

export function setIslandToggleHandler(fn: () => void): void {
  islandToggleHandler = fn
}

export function setHideToIslandHandler(fn: () => void): void {
  hideToIslandHandler = fn
}

export function setCollapseToIslandHandler(fn: () => void): void {
  collapseToIslandHandler = fn
}

export function popupPetMenu(): void {
  const win = petWindow
  if (!win) return
  const islandOn = loadConfig().window.island
  const menu = Menu.buildFromTemplate([
    { label: '设置', click: () => createSettingsWindow() },
    ...(islandToggleHandler
      ? [
          {
            // 开关：勾选=闲置自动收起；点击翻转
            label: islandOn ? '闲置自动收成灵动岛 ✓' : '闲置自动收成灵动岛 ✗',
            click: () => islandToggleHandler?.()
          }
        ]
      : []),
    ...(collapseToIslandHandler && islandOn
      ? [{ label: '立即收成灵动岛', click: () => collapseToIslandHandler?.() }]
      : []),
    { type: 'separator' },
    {
      label: '隐藏平板',
      click: () => (hideToIslandHandler ? hideToIslandHandler() : win.hide())
    },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() }
  ])
  menu.popup({ window: win })
}
