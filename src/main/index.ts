import { app, BrowserWindow, protocol, session } from 'electron'
import { join, normalize, sep } from 'path'
import { readFileSync, existsSync, statSync } from 'fs'
import { registerIpc } from './ipc'
import { createPetWindow } from './petWindow'
import { initIsland, showTablet } from './island'
import { createIslandWindow } from './islandWindow'
import { createTray } from './tray'
import { createSettingsWindow } from './settingsWindow'
import { startPluginBridge, stopPluginBridge } from './services/pluginBridge'
import { assetRoot, activeSkinDir, loadConfig } from './services/store'
import { warmUpGsv } from './services/gsv'

// 统一配置目录：打包版 productName 是中文（平板桌宠）、dev 是包名（deskpet-tablet），
// 显式钉到同一路径，README/AUTOSETU 里的 %APPDATA%\deskpet-tablet 对两种运行方式都成立
app.setPath('userData', join(app.getPath('appData'), 'deskpet-tablet'))

// 自定义资源协议：渲染层通过 petasset://assets/... 访问 assets 目录（视频/图片/清单）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'petasset',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }
])

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.js': 'text/javascript',
  '.moc3': 'application/octet-stream',
  '.model3.json': 'application/json',
  '.motion3.json': 'application/json',
  '.exp3.json': 'application/json',
  '.cdi3.json': 'application/json'
}

function serveAsset(url: string, request: Request): Response {
  // ⚠ standard scheme 会把第一段当主机名：petasset://skin/x → host='skin'、pathname='/x'。
  //   按 host 路由（旧代码按 pathname 判断恰好因 host='assets' 被丢弃而等效）
  const parsed = new URL(url)
  let root: string
  if (parsed.host === 'skin') {
    root = activeSkinDir()
  } else {
    root = assetRoot()
  }
  const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  const full = normalize(join(root, rel))
  if (!full.startsWith(root + sep) && full !== root) {
    return new Response('forbidden', { status: 403 })
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    return new Response('not found', { status: 404 })
  }
  const type = MIME[join(full).split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'
  const data = new Uint8Array(readFileSync(full))
  const range = request.headers.get('range')
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end = match[2] ? parseInt(match[2], 10) : data.length - 1
      const slice = data.subarray(start, end + 1)
      return new Response(slice, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(slice.length),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        }
      })
    }
  }
  return new Response(data, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(data.length),
      'Accept-Ranges': 'bytes',
      // 素材/清单热更新后 Chromium 的启发式缓存会返回旧数据
      'Cache-Control': 'no-cache',
      // PIXI/Live2D 从页面 origin 跨 scheme fetch 模型文件需要 CORS
      'Access-Control-Allow-Origin': '*'
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 语音播报不依赖用户手势触发 AudioContext
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  // PET_REMOTE_DEBUG=1 时开 CDP 调试端口（渲染层调试取证用）；端口可用
  // PET_REMOTE_DEBUG_PORT 覆盖（默认 9222 被幽灵句柄占着时换个口即可）
  if (process.env['PET_REMOTE_DEBUG'] === '1') {
    app.commandLine.appendSwitch('remote-debugging-port', process.env['PET_REMOTE_DEBUG_PORT'] || '9222')
  }

  app.on('second-instance', () => {
    showTablet(false) // 再次启动 = 想找她：岛态直接唤回平板
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    // 语音输入要用麦克风：只放行媒体权限，其余维持默认拒绝
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media')
    })

    protocol.handle('petasset', (request) => serveAsset(request.url, request))

    registerIpc()
    startPluginBridge() // 桥先起：打包版桌宠窗口要从桥加载页面（见 petWindow.ts）
    createPetWindow()
    void warmUpGsv(loadConfig().tts) // 预热本地语音：模型先装显存，用户第一句话不再冷启动
    initIsland() // 灵动岛闲置计时挂在桌宠窗口的 blur/focus 上（窗口已建好）
    createIslandWindow() // 独立岛窗口：闲置收起平板后亮出胶囊
    createTray()
    if (process.env['PET_OPEN_SETTINGS'] === '1') {
      createSettingsWindow()
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createPetWindow()
    })
  })

  // 桌宠常驻：关掉窗口不退出，走托盘退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // 保持托盘常驻，不退出
    }
  })

  app.on('will-quit', () => stopPluginBridge())
}
