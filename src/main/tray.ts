import { Tray, Menu, app, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { activeSkinDir, activeSkinMeta, loadConfig } from './services/store'
import { getPetWindow } from './petWindow'
import { createSettingsWindow } from './settingsWindow'
import { toggleIslandEnabled, showTablet, toggleTabletVisible, collapseToIslandNow } from './island'

let tray: Tray | null = null

/** 托盘图标：优先当前皮肤声明的贴纸，缺省回退内置贴纸 */
function trayIconPath(): string {
  const skin = activeSkinMeta(loadConfig())
  if (skin?.tray) {
    const p = join(activeSkinDir(loadConfig()), skin.tray)
    if (existsSync(p)) return p
  }
  return join(activeSkinDir(loadConfig()), 'stickers', 'placeholder-idle.png')
}

/** 灵动岛是带勾选状态的开关：点菜单切换后、设置页改配置后都要重建，勾选态才跟手 */
function buildMenu(): Menu {
  const islandOn = loadConfig().window.island
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏平板', click: () => toggleTabletVisible() },
    {
      label: '闲置自动收成灵动岛',
      type: 'checkbox',
      checked: islandOn,
      click: () => {
        toggleIslandEnabled()
        refreshTrayMenu()
      }
    },
    ...(islandOn ? [{ label: '立即收成灵动岛', click: () => collapseToIslandNow() }] : []),
    { label: '设置', click: () => createSettingsWindow() },
    { type: 'separator' },
    { label: '退出桌宠', click: () => app.quit() }
  ])
}

export function refreshTrayMenu(): void {
  tray?.setContextMenu(buildMenu())
}

/** 皮肤切换后刷新托盘图标（config:save 广播链路调用） */
export function refreshTrayIcon(): void {
  if (!tray) return
  try {
    tray.setImage(nativeImage.createFromPath(trayIconPath()).resize({ width: 32, height: 32 }))
  } catch {
    // 图标读不到就保持旧的
  }
}

export function createTray(): void {
  // 托盘图标取当前皮肤的贴纸，缩成 32x32
  const icon = nativeImage
    .createFromPath(trayIconPath())
    .resize({ width: 32, height: 32 })
  tray = new Tray(icon)
  tray.setToolTip('平板桌宠')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => {
    const win = getPetWindow()
    if (win && !win.isDestroyed() && win.isVisible()) win.focus()
    else showTablet(false) // 点托盘 = 想找她：岛态直接唤回平板
  })
}
