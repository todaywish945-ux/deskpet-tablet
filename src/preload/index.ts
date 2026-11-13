import { contextBridge, ipcRenderer } from 'electron'

const PET_EVENTS = [
  'pet:state',
  'pet:user-message',
  'pet:message',
  'pet:emotion',
  'pet:interrupt',
  'pet:llm-delta',
  'pet:llm-done',
  'pet:sentence',
  'pet:tts-preload',
  'pet:tts-start',
  'pet:tts-chunk',
  'pet:tts-end',
  'pet:tts-error',
  'pet:error',
  'pet:config-changed',
  'pet:bridge-audio-sink',
  'pet:island-mode',
  'pet:island-dock',
  'pet:tablet-hide-request',
  'pet:tablet-shown',
  'pet:island-focus-chat',
  'pet:call-start',
  'pet:call-end'
] as const

contextBridge.exposeInMainWorld('petAPI', {
  /** 发送一条消息给桌宠 */
  send: (text: string) => ipcRenderer.invoke('pet:send', text),
  /** 停止当前语音播报 */
  stop: () => ipcRenderer.invoke('pet:stop'),
  openSettings: () => ipcRenderer.invoke('app:open-settings'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximizeToggle: () => ipcRenderer.invoke('win:maximize-toggle'),
  winClose: () => ipcRenderer.invoke('win:close'),
  /** 可选角色皮肤列表（设置页下拉） */
  listSkins: () => ipcRenderer.invoke('skins:list'),
  hidePet: () => ipcRenderer.invoke('app:hide-pet'),
  startDrag: (offsetX: number, offsetY: number) => ipcRenderer.send('win:start-drag', offsetX, offsetY),
  endDrag: () => ipcRenderer.send('win:end-drag'),
  contextMenu: () => ipcRenderer.send('win:context-menu'),
  /** 平板渲染层：闲置收起请求，守卫通过后确认执行 */
  applyTabletHide: () => ipcRenderer.invoke('tablet:hide-apply'),
  /** 灵动岛：请求展开卡片（主进程放大窗口后回 pet:island-mode=card） */
  expandCard: () => ipcRenderer.send('island:expand-card'),
  /** 灵动岛：卡片收起动画播完，请主进程缩回胶囊 */
  collapseApply: () => ipcRenderer.invoke('island:collapse-card-apply'),
  /** 灵动岛：拖动胶囊（主进程 16ms 轮询光标） */
  startIslandDrag: (offsetX: number, offsetY: number) =>
    ipcRenderer.send('island:start-drag', offsetX, offsetY),
  endIslandDrag: () => ipcRenderer.send('island:end-drag'),
  /** 停靠细条：鼠标靠近/点击 → 滑出胶囊 */
  peekIsland: () => ipcRenderer.send('island:peek'),
  /** 滑出后鼠标离开 → 800ms 后收回细条 */
  retreatIsland: () => ipcRenderer.send('island:retreat'),
  /** 岛卡片按钮：唤回平板（focusChat=顺带聚焦输入框） */
  showTablet: (focusChat = false) => ipcRenderer.invoke('app:show-tablet', focusChat),
  /** 双击平板反应：head=摸头 body=点屏幕 */
  pat: (zone: 'head' | 'body') => ipcRenderer.invoke('pet:pat', zone),
  /** 视图变化上报（主界面/通话）：控制桥据此判断通话是否进行中 */
  notifyView: (view: 'home' | 'call') => ipcRenderer.send('win:view-changed', view),
  /** 全部会话（含消息） */
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  /** 新建会话并设为当前，返回会话对象 */
  createSession: (topic: string) => ipcRenderer.invoke('sessions:create', topic),
  /** 打开历史会话并设为当前 */
  openSession: (id: string) => ipcRenderer.invoke('sessions:open', id),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  deleteSessions: (ids: string[]) => ipcRenderer.invoke('sessions:delete-many', ids),
  /** 接通视频：由她围绕会话主题先开口 */
  beginCall: () => ipcRenderer.invoke('call:begin'),
  /** 档案记忆：她长期记住的关于用户的事实 */
  getProfile: () => ipcRenderer.invoke('profile:get'),
  deleteProfileFact: (factId: string) => ipcRenderer.invoke('profile:delete-fact', factId),
  on: (channel: (typeof PET_EVENTS)[number], callback: (...args: unknown[]) => void) => {
    if (!(PET_EVENTS as readonly string[]).includes(channel)) return
    const listener = (_event: unknown, ...args: unknown[]): void => callback(...args)
    ipcRenderer.on(channel, listener)
  }
})

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  enrollVoice: () => ipcRenderer.invoke('voice:enroll'),
  testVoice: (text: string) => ipcRenderer.invoke('voice:test', text),
  pickRefAudio: () => ipcRenderer.invoke('voice:pick-ref-audio'),
  probeGsv: (apiBase: string) => ipcRenderer.invoke('voice:probe-gsv', apiBase),
  openPet: () => ipcRenderer.invoke('app:toggle-pet'),
  quit: () => ipcRenderer.invoke('app:quit')
})
