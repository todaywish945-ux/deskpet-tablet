import { ipcMain, app, dialog, BrowserWindow, screen } from 'electron'
import { AppConfig, TTSConfig } from '../shared/types'
import { getPetWindow, startDrag, stopDrag, popupPetMenu, applyPetLayer, focusPetWindow, setIslandToggleHandler, setHideToIslandHandler, setCollapseToIslandHandler, PET_WIDTH, PET_HEIGHT } from './petWindow'
import {
  initIsland,
  setIslandBusyGuard,
  applyIslandConfig,
  toggleIslandEnabled,
  applyTabletHide,
  showTablet,
  toggleTabletVisible,
  hideTabletShowIsland,
  collapseToIslandNow
} from './island'
import { expandCard, collapseToCapsule, startIslandDrag, stopIslandDrag, peekIsland, retreatIsland } from './islandWindow'
import { refreshTrayMenu, refreshTrayIcon } from './tray'
import { createSettingsWindow } from './settingsWindow'
import { petPat, isTurnActive, isPatActive, cancelPat } from './services/chatPipeline'
import { emitPetEvent } from './services/petEvents'
import { noteUserActivity, startProactive } from './services/proactive'
import { ensureGsvService, stopSpawnedGsvExcept, warmUpGsv } from './services/gsv'
import { getActiveSessionId, setActiveSession, setCallActive } from './services/sessionState'
import {
  loadConfig,
  saveConfig,
  loadSessions,
  saveSessions,
  newSession,
  listSkins,
  resolveTtsConfig,
  assetRoot
} from './services/store'
import { runTurn, cancelActiveTurn } from './services/chatPipeline'
import { loadProfile, deleteFact } from './services/profile'
import { enrollVoice } from './services/enrollment'
import { checkForUpdate, downloadLatestInstaller, installDownloadedInstaller, cancelDownload, openReleasePage, getUpdateNotice } from './services/updater'
import { availableSkins, downloadSkin, cancelSkinDownload } from './services/skinStore'
import { synthesizeWav } from './services/tts'

export function registerIpc(): void {
  ipcMain.handle('pet:send', (_event, text: string) => {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return
    noteUserActivity() // 主动开口的闲置计时从这里刷新
    // 通话视图必然已有会话；兜底再建一个，标题由第一条消息生成
    if (!getActiveSessionId()) {
      const store = loadSessions()
      const session = newSession('')
      store.sessions.unshift(session)
      saveSessions(store)
      setActiveSession(session.id)
    }
    void runTurn({
      petWindow: getPetWindow(),
      config: loadConfig(),
      sessionId: getActiveSessionId()!,
      text: trimmed
    })
  })

  ipcMain.handle('pet:stop', () => {
    cancelActiveTurn()
  })

  /** 双击平板：摸头（头）/ 点屏幕（其他部位）反应 */
  ipcMain.handle('pet:pat', (_event, zone: string) => {
    void petPat(getPetWindow(), loadConfig(), zone === 'head' ? 'head' : 'body')
  })

  // ---------- 会话与通话 ----------

  ipcMain.handle('sessions:list', () => loadSessions())

  ipcMain.handle('sessions:create', (_event, topic: string) => {
    const store = loadSessions()
    const session = newSession((topic ?? '').trim())
    store.sessions.unshift(session)
    saveSessions(store)
    setActiveSession(session.id)
    return session
  })

  ipcMain.handle('sessions:open', (_event, id: string) => {
    const store = loadSessions()
    const session = store.sessions.find((s) => s.id === id) ?? null
    setActiveSession(session?.id ?? null)
    return session
  })

  ipcMain.handle('sessions:delete', (_event, id: string) => {
    const store = loadSessions()
    store.sessions = store.sessions.filter((s) => s.id !== id)
    saveSessions(store)
    if (getActiveSessionId() === id) setActiveSession(null)
    return store
  })

  ipcMain.handle('sessions:delete-many', (_event, ids: string[]) => {
    const doomed = new Set(Array.isArray(ids) ? ids : [])
    const store = loadSessions()
    store.sessions = store.sessions.filter((s) => !doomed.has(s.id))
    saveSessions(store)
    const active = getActiveSessionId()
    if (active && doomed.has(active)) setActiveSession(null)
    return store
  })


  /** 接通视频：由她围绕主界面定的主题先开口 */
  ipcMain.handle('call:begin', () => {
    const sessionId = getActiveSessionId()
    if (!sessionId) return false
    const session = loadSessions().sessions.find((s) => s.id === sessionId)
    if (!session || session.messages.length > 0) return false
    void runTurn({
      petWindow: getPetWindow(),
      config: loadConfig(),
      sessionId,
      opening: session.topic
    })
    return true
  })

  // ---------- 窗口控制（右上角三键） ----------
  ipcMain.handle('win:minimize', () => {
    // 灵动岛开启：最小化 = 直接收成灵动岛（不进任务栏）；关闭时保持原任务栏最小化
    if (loadConfig().window.island) hideTabletShowIsland()
    else getPetWindow()?.minimize()
  })

    ipcMain.handle('win:maximize-toggle', () => {
    const win = getPetWindow()
    if (!win) return
    const { workArea } = screen.getPrimaryDisplay()
    const [w, h] = win.getSize()
    if (w > PET_WIDTH + 10) {
      // 大屏态 → 回标准尺寸（原位缩回，缩放归 1）
      const [x, y] = win.getPosition()
      win.setBounds({ x, y, width: PET_WIDTH, height: PET_HEIGHT })
      win.webContents.setZoomFactor(1)
    } else {
      // 标准态 → 适配工作区（居中，等比缩放）
      const z = Math.min(workArea.width / PET_WIDTH, workArea.height / PET_HEIGHT)
      const W = Math.round(PET_WIDTH * z)
      const H = Math.round(PET_HEIGHT * z)
      const x = workArea.x + Math.max(0, Math.round((workArea.width - W) / 2))
      const y = workArea.y + Math.max(0, Math.round((workArea.height - H) / 2))
      win.setBounds({ x, y, width: W, height: H })
      win.webContents.setZoomFactor(z)
    }
  })

  ipcMain.handle('win:close', () => {
    app.quit()
  })

  // ---------- 档案记忆 ----------

  // 档案面板只看当前角色自己的记忆卡（爱心挂在谁的组头上就看谁的）
  ipcMain.handle('profile:get', () => loadProfile(loadConfig().character?.skin))
  ipcMain.handle('profile:delete-fact', (_event, factId: string) => deleteFact(String(factId), loadConfig().character?.skin))

  // ---------- 喜欢的代理人：邀约卡星标（状态落在配置 character.favorite） ----------
  ipcMain.handle('char:favorite-get', () => loadConfig().character.favorite)
  ipcMain.handle('char:favorite-set', (_event, favorite: boolean) => {
    const config = loadConfig()
    saveConfig({ ...config, character: { ...config.character, favorite: Boolean(favorite) } })
    return true
  })

  ipcMain.handle('app:open-settings', () => {
    createSettingsWindow()
  })
  ipcMain.handle('app:quit', () => app.quit())
  ipcMain.handle('app:hide-pet', () => hideTabletShowIsland())
  ipcMain.handle('app:toggle-pet', () => toggleTabletVisible())
  /** 岛卡片按钮：唤回平板（focusChat=顺带聚焦输入框） */
  ipcMain.handle('app:show-tablet', (_event, focusChat?: boolean) => showTablet(Boolean(focusChat)))

  ipcMain.on('win:start-drag', (_event, offsetX: number, offsetY: number) => {
    startDrag(offsetX, offsetY)
  })
  ipcMain.on('win:end-drag', () => stopDrag())
  ipcMain.on('win:context-menu', () => popupPetMenu())
  // 前台自愈：页面失焦却收到点击时补一次激活（see petWindow.focusPetWindow）
  ipcMain.on('win:focus-request', () => focusPetWindow())
  // 渲染层视图变化上报（主界面/通话）：控制桥的通话端点据此判断通话是否进行中
  ipcMain.on('win:view-changed', (_event, view: string) => {
    setCallActive(view === 'call')
  })

  // ---------- 灵动岛 ----------

  // 平板渲染层守卫（录音/播报中）通过：藏平板、亮出岛
  ipcMain.handle('tablet:hide-apply', () => applyTabletHide())
  // 岛渲染层：展开卡片（主进程放大窗口后回 pet:island-mode，内容动画在渲染层）
  ipcMain.on('island:expand-card', () => expandCard())
  // 岛渲染层卡片收起动画播完：缩回胶囊
  ipcMain.handle('island:collapse-card-apply', () => collapseToCapsule())
  ipcMain.on('island:start-drag', (_event, offsetX: number, offsetY: number) => {
    startIslandDrag(offsetX, offsetY)
  })
  ipcMain.on('island:end-drag', () => stopIslandDrag())
  // 停靠细条：鼠标靠近/点击滑出，离开 800ms 收回
  ipcMain.on('island:peek', () => peekIsland())
  ipcMain.on('island:retreat', () => retreatIsland())
  // 右键菜单的灵动岛开关：切换后托盘勾选态要跟着刷新
  setIslandToggleHandler(() => {
    toggleIslandEnabled()
    refreshTrayMenu()
  })
  // 右键菜单"隐藏平板"：灵动岛开着要顺带亮出岛
  setHideToIslandHandler(() => hideTabletShowIsland())
  setCollapseToIslandHandler(() => collapseToIslandNow())

  ipcMain.handle('config:get', () => loadConfig())
  /** 可选皮肤列表（设置页下拉）：内置 assets/skins + 用户 userData/skins 合并 */
  ipcMain.handle('skins:list', () => listSkins())
  /** 敲敲界面内切换角色：与设置页换肤走同一套切换动作（取消在途回合/换语音端口/托盘/广播） */
  ipcMain.handle('char:activate', (_event, skinId: string) => {
    const target = String(skinId ?? '')
    if (!target || !listSkins().some((meta) => meta.id === target)) return false
    const current = loadConfig()
    if (current.character.skin === target) return true
    const config: AppConfig = { ...current, character: { ...current.character, skin: target } }
    const ttsConfig = resolveTtsConfig(config)
    const sender = makeBroadcastSender()
    cancelActiveTurn(sender)
    cancelPat(sender)
    saveConfig(config)
    void switchGsvForCharacter(ttsConfig, sender)
    refreshTrayIcon() // 托盘图标跟皮肤走
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pet:config-changed')
    }
    return true
  })
  ipcMain.handle('config:save', (_event, config: AppConfig) => {
    const skinChanged = loadConfig().character.skin !== config.character.skin
    const ttsConfig = resolveTtsConfig(config) // 保存前校验，坏声明不能静默沿用旧音色
    const sender = makeBroadcastSender()
    if (skinChanged) {
      cancelActiveTurn(sender)
      cancelPat(sender)
    }
    saveConfig(config)
    if (skinChanged) {
      // 只确保新端口在线，不调用共享实例的 /set_*weights，也不在普通保存时重载模型。
      void switchGsvForCharacter(ttsConfig, sender)
    }
    // 窗口层级等设置改完立即生效
    applyPetLayer()
    applyIslandConfig()
    applyAutoStart(config)
    refreshTrayMenu() // 设置页改了灵动岛开关，托盘勾选态跟着刷新
    refreshTrayIcon() // 皮肤可能换了：托盘图标跟皮肤走
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('pet:config-changed')
    }
    return true
  })

  ipcMain.handle('voice:enroll', async () => {
    const config = loadConfig()
    const result = await enrollVoice(config.tts, assetRoot())
    saveConfig({ ...config, tts: { ...config.tts, voice: result.voiceId } })
    return { voiceId: result.voiceId }
  })

  ipcMain.handle('voice:test', async (_event, text: string) => {
    const ttsConfig = resolveTtsConfig(loadConfig())
    const wav = await synthesizeWav(ttsConfig, text)
    return { wav: wav.toString('base64') }
  })

  ipcMain.handle('voice:pick-ref-audio', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 GPT-SoVITS 参考音频',
      filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return { path: '' }
    return { path: result.filePaths[0] }
  })

  /** 探测本地 GPT-SoVITS api_v2 是否在线 */
  ipcMain.handle('voice:probe-gsv', async (_event, apiBase: string) => {
    const base = (apiBase || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      const response = await fetch(base, { signal: controller.signal })
      clearTimeout(timer)
      return { online: response.ok, status: response.status }
    } catch {
      return { online: false, status: 0 }
    }
  })

  // ---------- 软件更新（设置页「检查更新」） ----------

  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('update:check', () => checkForUpdate())
  // 下载在主进程流式跑，进度经 event.sender 推给发起请求的设置窗口
  ipcMain.handle('update:download', (event) => downloadLatestInstaller(event.sender))
  ipcMain.handle('update:cancel-download', () => {
    cancelDownload()
    return true
  })
  ipcMain.handle('update:install', () => installDownloadedInstaller())
  ipcMain.handle('update:open-page', (_event, url: string) => openReleasePage(url))
  // 主界面「可更新」圆点的数据源：启动时静默检查的缓存结果
  ipcMain.handle('update:notice', () => getUpdateNotice())

  // ---------- 应用内下载角色（皮肤包） ----------

  ipcMain.handle('skins:available', () => availableSkins())
  // 下载在主进程流式跑，进度经 event.sender 推给发起请求的设置窗口
  ipcMain.handle('skins:download', (event, id: string) => downloadSkin(id, event.sender))
  ipcMain.handle('skins:cancel-download', () => {
    cancelSkinDownload()
    return true
  })

  // ---------- 启动常驻服务 ----------

  // 本地语音服务没开就最小化自动拉起，省去先点启动脚本这一步；
  // 顺手清掉上次运行留下的闲置角色实例（台账只记本应用拉起的，手动开的绝不碰）
  void Promise.resolve()
    .then(async () => {
      const ttsConfig = resolveTtsConfig(loadConfig())
      const stopped = await stopSpawnedGsvExcept(ttsConfig.gsvApiBase).catch(() => [] as string[])
      if (stopped.length > 0) console.log('[gsv] 启动清理闲置语音实例:', stopped.join(', '))
      await ensureGsvService(ttsConfig)
    })
    .catch((error) => console.error('[gsv] 角色语音启动失败:', error))
  // 她主动开口（闲置关心 / 早安晚安 / 心情周回顾）
  startProactive()

  // 灵动岛：她忙不忙的守卫在主进程查（isTurnActive/isPatActive）
  setIslandBusyGuard(() => isTurnActive() || isPatActive())
}

/** 开机自启只对打包安装版有意义；dev 下只保存设置 */
function applyAutoStart(config: AppConfig): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: config.app.autoStart })
}

/** 主进程 → 所有窗口广播（pet 事件同时进 emitPetEvent 给控制桥/插件桥） */
function makeBroadcastSender(): (channel: string, ...args: unknown[]) => void {
  return (channel: string, ...args: unknown[]): void => {
    emitPetEvent(channel, args)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
    }
  }
}

/** 换角色后的语音切换：停掉闲置实例（省显存）→ 确保新角色在线 → 后台预热（第一句话不再冷启动） */
async function switchGsvForCharacter(
  ttsConfig: TTSConfig,
  sender: (channel: string, ...args: unknown[]) => void
): Promise<void> {
  try {
    const stopped = await stopSpawnedGsvExcept(ttsConfig.gsvApiBase)
    if (stopped.length > 0) console.log('[gsv] 换角色，清理闲置语音实例:', stopped.join(', '))
  } catch (error) {
    console.error('[gsv] 清理闲置语音实例失败:', error)
  }
  try {
    await ensureGsvService(ttsConfig)
  } catch (error: unknown) {
    console.error('[gsv]', error)
    sender('pet:tts-error', (error as Error).message)
  }
  void warmUpGsv(ttsConfig) // 后台预热模型，别让第一句话等冷启动
}
