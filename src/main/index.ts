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
import { assetRoot, activeSkinDir, findSkinDir, loadConfig, resolveTtsConfig } from './services/store'
import { stopSpawnedGsvExcept, warmUpGsv } from './services/gsv'
import { processStagedSkinInstalls } from './services/skinStore'

// 产品名已改为「敲敲」：数据目录沿用旧名，历史配置/会话/记忆（含 API Key）原地保留，
// 绝不能因为改名搬到新目录——一搬就等于用户数据全丢。
// --user-data-dir 显式指定时以它为准（仅开发/验证使用），正式启动才钉到旧目录。
if (!process.argv.some((arg) => arg.startsWith('--user-data-dir'))) {
  app.setPath('userData', join(app.getPath('appData'), 'ye-shunguang-deskpet'))
}

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
  '.svg': 'image/svg+xml',
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
  let rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  if (parsed.host === 'skins') {
    const [id, ...parts] = rel.split('/')
    const selected = findSkinDir(id)
    if (!selected) return new Response('not found', { status: 404 })
    root = selected
    rel = parts.join('/')
  } else if (parsed.host === 'skin') {
    root = activeSkinDir()
  } else {
    root = assetRoot()
  }
  const full = normalize(join(root, rel))
  if (!full.startsWith(root + sep) && full !== root) {
    return new Response('forbidden', { status: 403 })
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    return new Response('not found', { status: 404 })
  }
  // ⚠ MIME 键带前导点：split('.').pop() 给的是无点扩展名（'svg'），要补 '.' 再查。
  //   旧写法永远查不到、全部落 octet-stream——位图/视频/字体靠 Chromium 内容嗅探侥幸能用，
  //   唯独 <img> 里的 SVG 必须正确的 image/svg+xml 才渲染（敲敲图标裂图即此因）
  const ext = '.' + (join(full).split('.').pop() ?? '').toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
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
          'Cache-Control': 'no-cache',
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
  // 透明窗口 + 视频：禁用系统级视频叠加层。叠加层无视页面圆角裁剪，
  // 说话时视频层频繁切换/淡入淡出被提升的那几帧会在窗口四角漏出直角方块（闪角）
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays')
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

    // 上次下载的角色包如果走了"重启替换"，在窗口创建前就位（此刻绝无播放器文件锁）
    processStagedSkinInstalls()

    protocol.handle('petasset', (request) => serveAsset(request.url, request))

    registerIpc()
    startPluginBridge() // 桥先起：打包版桌宠窗口要从桥加载页面（见 petWindow.ts）
    createPetWindow()
    // 先清掉上次运行留下的闲置角色实例（台账只记本应用拉起的，手动开的绝不碰），再预热当前角色。
    // 预热同样使用当前角色快照；声明损坏只报错，不阻止窗口初始化。
    void Promise.resolve()
      .then(async () => {
        const ttsConfig = resolveTtsConfig(loadConfig())
        const stopped = await stopSpawnedGsvExcept(ttsConfig.gsvApiBase).catch(() => [] as string[])
        if (stopped.length > 0) console.log('[gsv] 启动清理闲置语音实例:', stopped.join(', '))
        await warmUpGsv(ttsConfig)
      })
      .catch((error) => console.error('[gsv] 角色语音预热失败:', error))
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
