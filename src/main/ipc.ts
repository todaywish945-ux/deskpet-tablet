import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { AppConfig } from '../shared/types'
import { getPetWindow, startDrag, stopDrag, popupPetMenu, applyPetLayer, setIslandToggleHandler, setHideToIslandHandler, setCollapseToIslandHandler } from './petWindow'
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
import { petPat, isTurnActive, isPatActive } from './services/chatPipeline'
import { noteUserActivity, startProactive } from './services/proactive'
import { ensureGsvService } from './services/gsv'
import { getActiveSessionId, setActiveSession, setCallActive } from './services/sessionState'
import {
  loadConfig,
  saveConfig,
  loadSessions,
  saveSessions,
  newSession,
  listSkins,
  assetRoot
} from './services/store'
import { runTurn, cancelActiveTurn } from './services/chatPipeline'
import { loadProfile, deleteFact } from './services/profile'
import { enrollVoice } from './services/enrollment'
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

  // ---------- 档案记忆 ----------

  ipcMain.handle('profile:get', () => loadProfile())
  ipcMain.handle('profile:delete-fact', (_event, factId: string) => deleteFact(String(factId)))

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
  ipcMain.handle('config:save', (_event, config: AppConfig) => {
    saveConfig(config)
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
    const wav = await synthesizeWav(loadConfig().tts, text)
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

  // ---------- 启动常驻服务 ----------

  // 本地语音服务没开就最小化自动拉起，省去先点启动脚本这一步
  void ensureGsvService(loadConfig().tts)
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
