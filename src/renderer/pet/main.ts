import type { ChatMessage, ChatSession, SkinMeta } from '../../shared/types'
import { Live2DPlayer } from './Live2DPlayer'
import { AnimationPlayer } from './AnimationPlayer'
import { PcmPlayer } from './PcmPlayer'

const api = window.petAPI

const bubble = document.getElementById('bubble') as HTMLDivElement
const bubbleText = document.getElementById('bubble-text') as HTMLSpanElement
const userToast = document.getElementById('user-toast') as HTMLDivElement
// 敲敲式消息行：显隐类挂在行上（头像随气泡一起出现/消失）
const bubbleRow = document.getElementById('bubble-row') as HTMLDivElement
const toastRow = document.getElementById('toast-row') as HTMLDivElement
const bubbleAvatar = document.getElementById('bubble-avatar') as HTMLImageElement
const waveform = document.getElementById('waveform') as HTMLElement
const callLabel = document.getElementById('call-label') as HTMLElement
const callName = document.querySelector('#statusbar .name') as HTMLSpanElement
const form = document.getElementById('inputbar') as HTMLFormElement
const input = document.getElementById('chat-input') as HTMLInputElement
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement

const homeView = document.getElementById('home-view') as HTMLDivElement
const callView = document.getElementById('call-view') as HTMLDivElement
const sessionList = document.getElementById('session-list') as HTMLDivElement
const manageSessionsBtn = document.getElementById('manage-sessions-btn') as HTMLButtonElement
const batchBar = document.getElementById('batch-bar') as HTMLDivElement
const batchSelectAllBtn = document.getElementById('batch-select-all') as HTMLButtonElement
const batchDeleteBtn = document.getElementById('batch-delete') as HTMLButtonElement
const batchCancelBtn = document.getElementById('batch-cancel') as HTMLButtonElement
const winMinBtn = document.getElementById('win-min') as HTMLButtonElement
const winMaxBtn = document.getElementById('win-max') as HTMLButtonElement
const winCloseBtn = document.getElementById('win-close') as HTMLButtonElement
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement
winMinBtn.addEventListener('click', () => void api.winMinimize())
winMaxBtn.addEventListener('click', () => void api.winMaximizeToggle())
winCloseBtn.addEventListener('click', () => void api.winClose())
settingsBtn.addEventListener("click", () => void api.openSettings())
const topicInput = document.getElementById('topic-input') as HTMLInputElement

const sessionView = document.getElementById('session-view') as HTMLDivElement
const sessionTitleEl = document.getElementById('session-title') as HTMLSpanElement
const sessionWhenEl = document.getElementById('session-when') as HTMLSpanElement
const sessionPreview = document.getElementById('session-preview') as HTMLDivElement
// 主界面聊天窗（Knock Knock 融合）：直接打字聊，视频通话是窗口里的按钮
const homeInputbar = document.getElementById('home-inputbar') as HTMLFormElement
const homeChatInput = document.getElementById('home-chat-input') as HTMLInputElement
const homeCallBtn = document.getElementById('home-call-btn') as HTMLButtonElement
// 敲敲三选项卡：邀约（视频通话）/ 私信（聊天窗）/ 群聊（占位）
const tabVideo = document.getElementById('tab-video') as HTMLButtonElement
const tabChat = document.getElementById('tab-chat') as HTMLButtonElement
const tabGroup = document.getElementById('tab-group') as HTMLButtonElement
const sideVideo = document.getElementById('side-video') as HTMLDivElement
const sideChat = document.getElementById('side-chat') as HTMLDivElement
const sideGroup = document.getElementById('side-group') as HTMLDivElement
const inviteView = document.getElementById('invite-view') as HTMLDivElement
const groupView = document.getElementById('group-view') as HTMLDivElement
const impTitle = document.getElementById('imp-title') as HTMLDivElement
const impText = document.getElementById('imp-text') as HTMLDivElement
const inviteBtn = document.getElementById('invite-btn') as HTMLButtonElement
const inviteStar = document.getElementById('invite-star') as HTMLButtonElement | null
const inviteName = document.getElementById('invite-name') as HTMLElement

const profileCount = document.getElementById('profile-count') as HTMLSpanElement
const profilePanel = document.getElementById('profile-panel') as HTMLDivElement
const profileClose = document.getElementById('profile-close') as HTMLButtonElement
const profileList = document.getElementById('profile-list') as HTMLDivElement
// 敲敲侧栏：角色分组树（每个角色一张组头，头像/名字/爱心/＋新建/展开收起，renderSessions 动态生成）
const contactCards = document.getElementById('contact-cards') as HTMLDivElement
const sessionCharAvatar = document.getElementById('session-char-avatar') as HTMLImageElement
const sessionCharName = document.getElementById('session-char-name') as HTMLElement

const hangupBtn = document.getElementById('hangup-btn') as HTMLButtonElement
const historyToggle = document.getElementById('history-toggle') as HTMLButtonElement
const historyPanel = document.getElementById('history-panel') as HTMLElement
const historyClose = document.getElementById('history-close') as HTMLButtonElement
const historyList = document.getElementById('history-list') as HTMLDivElement

/** 渲染后端按皮肤 backend 选择：video 切片 / live2d 实时模型。皮肤切换时整体重建 */
let player: AnimationPlayer | Live2DPlayer = new AnimationPlayer(
  document.getElementById('char-layer') as HTMLElement
)
const pcm = new PcmPlayer()
let activeSkinId = ''
let skinMeta: SkinMeta | null = null
let skinRequest = 0

/** 拉当前皮肤包并（重建）渲染器。id 没变则跳过；force=启动/手动 */
async function applySkin(force = false): Promise<void> {
  const request = ++skinRequest
  let meta: SkinMeta | null = null
  try {
    meta = (await (await fetch(`petasset://skin/skin.json?ts=${Date.now()}`)).json()) as SkinMeta
  } catch {
    // 主进程路由兜底 assets 根：旧布局也能跑
  }
  if (request !== skinRequest || !meta?.id) return
  if (!force && meta.id === activeSkinId) return
  activeSkinId = meta.id
  skinMeta = meta
  const base = `petasset://skins/${encodeURIComponent(meta.id)}`
  const container = document.getElementById('char-layer') as HTMLElement
  stopSpeech()
  player.destroy()
  container.innerHTML = ''
  const nextPlayer = meta.backend === 'live2d'
    ? new Live2DPlayer(container, meta, base, () => pcm.level())
    : new AnimationPlayer(container, base)
  player = nextPlayer
  avatarUrl = `${base}/${meta.avatar}`
  bubbleAvatar.src = avatarUrl // 消息行头像随皮肤更新
  const inviteAvatar = document.getElementById('invite-avatar') as HTMLImageElement
  inviteAvatar.src = avatarUrl
  const charName = meta.name || '叶瞬光'
  inviteName.textContent = charName
  callName.textContent = charName
  input.placeholder = `跟${charName}说点什么…`
  renderSessions().catch(() => {}) // 会话树/联系人卡换新（组头头像用各自皮肤素材，当前组高亮跟着 activeSkinId 走）
  renderContactCards().catch(() => {})
  updateSessionCharBadge(currentSession?.characterId).catch(() => {})
  if (!inviteView.classList.contains('hidden')) void loadImpression() // 邀约页开着时印象标题跟着换人
  if (!force) {
    // 换角色：聊天窗跟着换人——接上她最近一段会话，没有历史就空窗。
    // 不做这一步的话，旧角色的会话还开着，新角色的回复会混进同一条对话里
    void handoffSessionOnSwitch(meta.id).catch(() => {})
  }
  const wp = document.getElementById('wallpaper') as HTMLImageElement
  if (meta.wallpaper) {
    wp.src = `${base}/${meta.wallpaper}`
    wp.classList.remove('hidden')
  } else {
    wp.removeAttribute('src')
    wp.classList.add('hidden')
  }
  await nextPlayer.init()
}

let workingText = ''
/** 字幕模式已出的字：每句音频到达时由 pet:sentence 逐句追加，跟着声音走 */
let revealedText = ''
let shownEmotion: string | null = null
let userToastTimer: ReturnType<typeof setTimeout> | null = null
let errorTimer: ReturnType<typeof setTimeout> | null = null

/** 当前选中的会话（主界面左侧点选 / 新建），null 表示还没定 */
let currentSession: ChatSession | null = null
let currentView: 'home' | 'call' = 'home'

/** 流式过程中把（可能只来了一半的）情绪标签从展示文本里滤掉；同时裁掉残留的开头/结尾空白 */
function displayFilter(text: string): string {
  return text.replace(/\[emotion[：:][a-z_]*\]?/gi, '').trim()
}

/** 点击落在可交互 UI 上时，不当作"点了屏幕人物"（动画层穿透后防误触） */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.(
    'button, input, textarea, #call-bar, #statusbar, #bubble, #user-toast, #history-panel, #home-view, #profile-panel, #win-controls, #settings-btn'
  )
}

function showBubble(html: string, isError = false): void {
  bubbleRow.classList.remove('hidden')
  // 内层气泡自身也可能带着 HTML 初始的 hidden（重构气泡行时引入的双重 hidden）
  bubble.classList.remove('hidden')
  bubble.classList.toggle('error', isError)
  bubbleText.innerHTML = html
  bubble.scrollTop = bubble.scrollHeight
}

function showThinking(): void {
  showBubble('<span class="dots"><i></i><i></i><i></i></span>')
}

function showUserToast(text: string, autoFadeMs = 60_000): void {
  userToast.textContent = text
  // 内层气泡自身也带着 HTML 初始的 hidden（与 #bubble 同款双重 hidden）
  userToast.classList.remove('hidden')
  toastRow.classList.remove('hidden', 'fade')
  if (userToastTimer) {
    clearTimeout(userToastTimer)
    userToastTimer = null
  }
  // 按传入时长自动淡出；用户消息 3 秒（发出去就别一直占着画面），
  // 系统提示类（bridge 接管声音等）按 60 秒兜底
  if (autoFadeMs > 0) userToastTimer = setTimeout(fadeUserToast, autoFadeMs)
}

function hideUserToast(): void {
  if (userToastTimer) {
    clearTimeout(userToastTimer)
    userToastTimer = null
  }
  toastRow.classList.add('hidden')
  toastRow.classList.remove('fade')
}

function fadeUserToast(): void {
  userToastTimer = null
  toastRow.classList.add('fade')
  setTimeout(() => toastRow.classList.add('hidden'), 700)
}


// ---------- 事件接线 ----------

// ---------- 主界面聊天窗：live 渲染（不出镜聊天时，她的回复在窗口里长出来） ----------

let homeLiveMsg: HTMLDivElement | null = null // 她正在生成的气泡（三点 → 流式句子 → 定稿）
let homeLiveText = ''

/** 主聊天窗当前可见（home 视图 + 会话视图展开）才操作它的 DOM */
function homeChatVisible(): boolean {
  return currentView === 'home' && !sessionView.classList.contains('hidden')
}

function appendHomeRow(row: HTMLDivElement): void {
  sessionPreview.querySelector('.empty-zzz')?.remove()
  sessionPreview.appendChild(row)
  sessionPreview.scrollTop = sessionPreview.scrollHeight
}

function removeHomeLive(): void {
  homeLiveMsg = null
  homeLiveText = ''
  sessionPreview.querySelector('.h-row.live')?.remove()
}

/** 她开始想：聊天窗里放一个三点气泡（复用通话气泡的三点样式） */
function showHomeThinking(): void {
  if (!homeChatVisible()) return
  removeHomeLive()
  const row = document.createElement('div')
  row.className = 'h-row assistant live'
  const avatar = document.createElement('img')
  avatar.className = 'avatar'
  avatar.src = avatarUrl
  avatar.draggable = false
  const msg = document.createElement('div')
  msg.className = 'h-msg assistant'
  msg.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'
  row.append(avatar, msg)
  appendHomeRow(row)
  homeLiveMsg = msg
}

/** 流式句子到达：整句追加进她的 live 气泡（逐字打字机是通话气泡专属） */
function homeSentence(text: string): void {
  if (!homeChatVisible() || !homeLiveMsg) return
  homeLiveText += text
  homeLiveMsg.textContent = homeLiveText
  sessionPreview.scrollTop = sessionPreview.scrollHeight
}

/** 回复定稿：live 气泡原位定稿；没有 live（比如用户切过视图）就整行补一条。
 *  isError=true 时红字显示（整轮失败的提示，不然"思考中"三点会一直挂着）。
 *  注意：切到别的页/通话中时不能丢——之前这里直接 return，回来只看到卡住的三点，
 *  看着就像她没回复。预览 DOM 属于当前会话，隐藏时照常写入，切回来就是完整对话。 */
function finalizeHomeAssistant(content: string, ts: number, isError = false): void {
  const clean = content.trim()
  if (!homeLiveMsg || !homeChatVisible()) {
    homeLiveMsg = null
    removeHomeLive() // 切走期间挂在预览里的"思考中"行要清掉
  }
  if (!clean || !currentSession) return
  if (!homeLiveMsg) {
    const row = historyMessageNode({ role: 'assistant', content: clean, ts })
    if (isError) row.querySelector('.h-msg')?.classList.add('error')
    appendHomeRow(row)
    return
  }
  homeLiveMsg.textContent = clean
  if (isError) homeLiveMsg.classList.add('error')
  const when = document.createElement('span')
  when.className = 'when'
  when.textContent = formatTime(ts)
  homeLiveMsg.appendChild(when)
  homeLiveMsg.closest('.h-row')?.classList.remove('live')
  homeLiveMsg = null
  homeLiveText = ''
  sessionPreview.scrollTop = sessionPreview.scrollHeight
}

/** 用户消息：聊天窗右侧补一条蓝泡（pet:user-message 只对真实输入发，hidden 开场不发）。
 *  不在私信页（通话中/切到邀约）也要补：聊天窗 DOM 属于当前会话，切回来要能对上完整一问一答 */
function appendHomeUserRow(text: string): void {
  if (!currentSession) return
  appendHomeRow(historyMessageNode({ role: 'user', content: text, ts: Date.now() }))
}

api.on('pet:state', (state) => {
  if (state === 'thinking') {
    revealedText = ''
    showThinking()
    showHomeThinking()
  }
})

api.on('pet:user-message', (text, sessionId) => {
  showUserToast(String(text), 3000)
  // 带会话 id 时只在它是当前展示的会话才补行，防止串台
  if (!sessionId || currentSession?.id === sessionId) appendHomeUserRow(String(text))
  renderHistoryIfOpen()
})

api.on('pet:llm-delta', (delta) => {
  workingText += String(delta)
  const display = displayFilter(workingText)
  if (display) showBubble(escapeHtml(display))
})

/** 字幕模式：这句的声音到了，字跟着出 */
// ---------- 字幕打字机：句子按语音时长逐字显出，文字跟着声音吐 ----------
let pendingChars = 0 // 已到达但还没显出的字数（从 revealedText 尾部数）
let revealTimer: number | null = null

api.on('pet:sentence', (sentence, durationMs) => {
  const text = String(sentence)
  revealedText += text
  pendingChars += text.length
  startReveal(Number(durationMs) || 0)
  homeSentence(text) // 主界面聊天窗：整句直出
})

function stopReveal(): void {
  if (revealTimer !== null) {
    window.clearInterval(revealTimer)
    revealTimer = null
  }
}

function startReveal(durationMs: number): void {
  if (revealTimer !== null) return // 正在显字：新句子的字追加进队列，节奏延续
  const dur = Math.min(15000, Math.max(400, durationMs || pendingChars * 160))
  const stepMs = 40
  revealTimer = window.setInterval(() => {
    // 每拍把「剩余字数 / 剩余拍数」显完：中途追加新句会自动加速追上
    const beatsLeft = Math.max(2, Math.ceil(dur / stepMs))
    const step = Math.max(1, Math.ceil(pendingChars / beatsLeft))
    if (pendingChars <= 0 || step <= 0) {
      stopReveal()
      return
    }
    pendingChars = Math.max(0, pendingChars - step)
    showBubble(escapeHtml(revealedText.slice(0, revealedText.length - pendingChars)))
  }, stepMs)
}

/** 展示情绪：同一情绪不重复插播（开头已演过的，llm-done 不再重放） */
function showEmotion(name: string): void {
  if (name === shownEmotion) return
  shownEmotion = name
  player.setEmotion(name)
}

api.on('pet:emotion', (name) => {
  showEmotion(String(name))
})

api.on('pet:llm-done', (payload) => {
  const { text, emotion } = payload as { text: string; emotion: string }
  workingText = ''
  // 字幕模式下 text 为空：字已由 pet:sentence 逐句出完，这里只管情绪
  if (text) {
    showBubble(escapeHtml(text))
    revealedText = text
  }
  showEmotion(emotion)
  // 兜底：pet:message(assistant) 先到的话这里已经是空的；还挂着 live 就用已有字幕定稿
  if (homeLiveMsg) finalizeHomeAssistant(text || homeLiveText, Date.now())
  renderHistoryIfOpen()
})

/** 主进程每落盘一条消息就推过来：追加进当前会话，通话记录面板实时长出来（不用等挂断刷新） */
api.on('pet:message', (payload) => {
  const { sessionId, message } = payload as { sessionId: string; message: ChatMessage }
  if (!currentSession || currentSession.id !== sessionId) return
  currentSession.messages.push(message)
  // 主界面聊天窗：她的回复原位定稿（用户行已由 pet:user-message 渲染，这里只管 assistant）
  if (message.role === 'assistant' && !message.hidden) {
    finalizeHomeAssistant(message.content, message.ts)
  }
  renderHistoryIfOpen()
})

const TALK_WATCHDOG_MS = 90_000
let talkWatchdogTimer: ReturnType<typeof setTimeout> | null = null
let speechPollTimer: ReturnType<typeof setInterval> | null = null
let speechTurn = 0
let speechProducing = false
let speechPreparing = false
let speechReady = false
let pendingAudio: string[] = []

function clearTalkWatchdog(): void {
  if (talkWatchdogTimer) clearTimeout(talkWatchdogTimer)
  talkWatchdogTimer = null
}

function clearSpeechPoll(): void {
  if (speechPollTimer) clearInterval(speechPollTimer)
  speechPollTimer = null
}

function syncSpeech(): void {
  if (speechPreparing || pendingAudio.length > 0) return
  if (!speechProducing && !pcm.busy) {
    clearSpeechPoll()
    speechReady = false
    waveform.classList.remove('on')
    callLabel.textContent = '视频通话中'
    player.finishTalkingAt(0)
    return
  }
  if (!speechReady) return
  if (player instanceof AnimationPlayer) player.setSpeechPaused(!pcm.playing)
  waveform.classList.toggle('on', pcm.playing)
  callLabel.textContent = pcm.playing ? '正在说话' : '等待语音'
}

function armTalkWatchdog(): void {
  clearTalkWatchdog()
  talkWatchdogTimer = setTimeout(() => {
    talkWatchdogTimer = null
    speechProducing = false
    syncSpeech()
  }, TALK_WATCHDOG_MS)
}

function stopSpeech(): void {
  speechTurn++
  speechProducing = false
  speechPreparing = false
  speechReady = false
  pendingAudio = []
  pcm.stop()
  clearTalkWatchdog()
  clearSpeechPoll()
  player.cancelFinishTimer()
  player.finishTalkingAt(0)
  waveform.classList.remove('on')
  callLabel.textContent = '视频通话中'
}

api.on('pet:tts-preload', () => player.preloadTalk())

api.on('pet:tts-start', () => {
  clearSpeechPoll()
  speechProducing = true
  callLabel.textContent = '等待语音'
  armTalkWatchdog()
  speechPollTimer = setInterval(syncSpeech, 20)
})

api.on('pet:tts-chunk', (chunk) => {
  speechProducing = true
  if (!speechPollTimer) speechPollTimer = setInterval(syncSpeech, 20)
  armTalkWatchdog()
  if (speechReady) {
    pcm.pushChunk(String(chunk))
    return
  }
  pendingAudio.push(String(chunk))
  if (speechPreparing) return
  speechPreparing = true
  const turn = speechTurn
  player.resumeAll()
  const ready = player instanceof AnimationPlayer
    ? player.startTalking()
    : (player.setTalking(true), Promise.resolve(true))
  void ready.then((started) => {
    if (turn !== speechTurn) return
    speechPreparing = false
    if (!started) {
      stopSpeech()
      return
    }
    speechReady = true
    for (const data of pendingAudio) pcm.pushChunk(data)
    pendingAudio = []
    syncSpeech()
  })
})

api.on('pet:interrupt', () => {
  stopSpeech()
  workingText = ''
  revealedText = ''
})

api.on('pet:tts-end', () => {
  clearTalkWatchdog()
  speechProducing = false
  syncSpeech()
})

api.on('pet:tts-error', (message) => {
  showBubble(escapeHtml(`（语音没播出来：${String(message)}）`), true)
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => bubbleRow.classList.add('hidden'), 6000)
})

api.on('pet:error', (message) => {
  const text = String(message)
  const hint = /API key|401|Unauthorized/i.test(text)
    ? `先去设置里把 API Key 配好：${text}`
    : `这轮没连上：${text}`
  showBubble(escapeHtml(hint), true)
  // 主界面聊天窗：把卡在"思考中"的 live 行换成红字提示（用户此刻看不见通话气泡）
  finalizeHomeAssistant(hint, Date.now(), true)
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => bubbleRow.classList.add('hidden'), 10000)
})

api.on('pet:config-changed', () => {
  void refreshCallFlags()
  void applySkin() // 皮肤可能换了：id 变了才重建渲染器
})

// 控制桥上有远程面板（DSH 里的内嵌通话卡）接管声音时，平板这边静音，免得双声道；
// 只关音量不停播报：动画/口型/状态机照常，面板一关声音自动还回来。
// 静音必须留痕——"张嘴说不出话"的头号来源就是它，无声时让用户当场知道声音去哪了
let bridgeOwnsAudio = false
/** 设置里的语音音量（0~1）：之前只存配置没接到播放端，导致她一直按满音量说话 */
let ttsVolume = 1
api.on('pet:bridge-audio-sink', (on) => {
  bridgeOwnsAudio = on === true
  pcm.setVolume(bridgeOwnsAudio ? 0 : ttsVolume)
  showUserToast(bridgeOwnsAudio ? '声音正在 dsh 面板播放（平板静音中）' : '声音回到平板了')
})

// ---------- 灵动岛（独立岛窗口）----------

/** 主进程闲置计时到点请求收起平板：守卫不过（她在播）静默忽略，主进程稍后重试 */
api.on('pet:tablet-hide-request', () => {
  if (speechProducing || speechPreparing || speechReady || pcm.busy) return
  player.pauseAll()
  void api.applyTabletHide()
})

/** 从岛卡片唤回平板：恢复动画 */
api.on('pet:tablet-shown', () => {
  player.resumeAll()
})

/** 岛卡片「开始聊天」：切到私信页并聚焦聊天输入框 */
api.on('pet:island-focus-chat', () => {
  if (currentView === 'call') input.focus()
  else {
    switchTab('chat')
    homeChatInput.focus()
  }
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------- 主界面：会话列表 + 话题 ----------

function formatTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return hm
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`
}

// ---------- 页面内确认弹窗（替代 window.confirm）----------
// 原生 confirm 是系统模态框，会抢走 OS 焦点 → 平板触发 blur → 120ms 沉底
// 计时把窗口压到 Z 序最底（点删除=整块退后台）。自绘弹窗不产生焦点转移。
function qqConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'qq-confirm-overlay'
    const card = document.createElement('div')
    card.className = 'qq-confirm-card'
    const text = document.createElement('div')
    text.className = 'qq-confirm-text'
    text.textContent = message
    const row = document.createElement('div')
    row.className = 'qq-confirm-row'
    const cancel = document.createElement('button')
    cancel.className = 'qq-confirm-btn'
    cancel.type = 'button'
    cancel.textContent = '取消'
    const ok = document.createElement('button')
    ok.className = 'qq-confirm-btn danger'
    ok.type = 'button'
    ok.textContent = '删除'
    row.append(cancel, ok)
    card.append(text, row)
    overlay.append(card)

    let settled = false
    const close = (result: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(result)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close(false)
    }
    cancel.addEventListener('click', () => close(false))
    ok.addEventListener('click', () => close(true))
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false)
    })
    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
  })
}

// ---------- 会话批量删除 ----------
let batchMode = false
const selectedSessions = new Set<string>()

function updateBatchBar(): void {
  const total = sessionList.querySelectorAll('.session-item').length
  batchDeleteBtn.textContent = `删除所选(${selectedSessions.size})`
  batchDeleteBtn.disabled = selectedSessions.size === 0
  batchSelectAllBtn.textContent = total > 0 && selectedSessions.size === total ? '全不选' : '全选'
}

function setBatchMode(on: boolean): void {
  batchMode = on
  selectedSessions.clear()
  manageSessionsBtn.classList.toggle('hidden', on)
  batchBar.classList.toggle('hidden', !on)
  sessionList.classList.toggle('batch', on)
  void renderSessions()
}

manageSessionsBtn.addEventListener('click', () => setBatchMode(true))
batchCancelBtn.addEventListener('click', () => setBatchMode(false))
batchSelectAllBtn.addEventListener("click", () => {
  const items = [...sessionList.querySelectorAll<HTMLElement>('.session-item')]
  const all = items.length > 0 && items.every((el) => el.dataset.sid && selectedSessions.has(el.dataset.sid))
  for (const el of items) {
    const sid = el.dataset.sid
    if (!sid) continue
    if (all) selectedSessions.delete(sid)
    else selectedSessions.add(sid)
  }
  updateBatchBar()
  void renderSessions()
})
batchDeleteBtn.addEventListener("click", () => {
  const ids = [...selectedSessions]
  if (ids.length === 0) return
  void qqConfirm(`删除选中的 ${ids.length} 个会话？（不可恢复）`).then((ok) => {
    if (!ok) return
    void api.deleteSessions(ids).then(() => {
      if (currentSession && ids.includes(currentSession.id)) resetComposer()
      selectedSessions.clear()
      updateBatchBar()
      void renderSessions()
    })
  })
})

// 角色分组展开状态（智谱任务列表式：角色行下拉直接挂会话），每个角色各记一份
const charGroupExpanded = new Map<string, boolean>()

/** 已知角色清单（分组树/联系人卡/会话头共用）：拉一次缓存住，渲染各处取用 */
let skinsCache: { id: string; name: string; avatar?: string }[] = []

async function refreshSkins(): Promise<{ id: string; name: string; avatar?: string }[]> {
  try {
    skinsCache = ((await api.listSkins()) ?? []) as { id: string; name: string; avatar?: string }[]
  } catch {
    // 拉不到沿用旧缓存
  }
  return skinsCache
}

function skinById(id?: string | null): { id: string; name: string; avatar?: string } | null {
  if (!id) return null
  return skinsCache.find((skin) => skin.id === id) ?? null
}

function skinAvatarSrc(skin: { id: string; avatar?: string }): string {
  return `petasset://skins/${encodeURIComponent(skin.id)}/${skin.avatar || 'avatar.png'}`
}

/** 切换角色：主进程整切（人设/动画/语音一起换），成功后本地立即同步一次，不等广播事件 */
async function activateCharacter(skinId: string): Promise<boolean> {
  if (!skinId || skinId === activeSkinId) return false
  const ok = await api.charActivate(skinId)
  if (ok) await applySkin()
  return ok
}

const HEART_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.9-9.7-9.2C.7 8.6 2.4 5 5.8 5c2 0 3.4 1.1 4.2 2.4L12 9l2-1.6C14.8 6.1 16.2 5 18.2 5c3.4 0 5.1 3.6 3.5 6.8C19.5 16.1 12 21 12 21z"/></svg>'

/** 一张角色组头：头像/名字点击切换角色，＋ 给这个角色开新会话，爱心（仅当前角色有）开档案面板 */
function buildGroupHead(skin: { id: string; name: string; avatar?: string }, isActive: boolean): HTMLDivElement {
  const head = document.createElement('div')
  head.className = 'char-group-head' + (isActive ? ' active' : '')
  head.dataset.skin = skin.id

  const avatar = document.createElement('img')
  avatar.className = 'g-avatar'
  avatar.src = skinAvatarSrc(skin)
  avatar.alt = ''
  avatar.draggable = false
  const name = document.createElement('span')
  name.className = 'g-name'
  name.textContent = skin.name || skin.id
  head.append(avatar, name)

  if (isActive) {
    const heart = document.createElement('button')
    heart.className = 'g-heart'
    heart.type = 'button'
    heart.title = '她记住的关于你'
    heart.innerHTML = HEART_SVG
    heart.addEventListener('click', (event) => {
      event.stopPropagation()
      void openProfilePanel()
    })
    head.appendChild(heart)
  }

  const add = document.createElement('button')
  add.className = 'g-add'
  add.type = 'button'
  add.title = `和${skin.name || '她'}开个新会话`
  add.textContent = '＋'
  add.addEventListener('click', (event) => {
    event.stopPropagation()
    void startNewSession(skin.id)
  })

  const chevron = document.createElement('i')
  chevron.className = 'g-chevron'
  const expanded = charGroupExpanded.get(skin.id) ?? true
  chevron.textContent = expanded ? '▾' : '▸'
  chevron.addEventListener('click', (event) => {
    event.stopPropagation()
    charGroupExpanded.set(skin.id, !expanded)
    void renderSessions()
  })

  head.append(add, chevron)
  head.addEventListener('click', () => {
    // 点别的角色 = 整体切过去（顺带展开）；点当前角色 = 收起/展开会话列表
    if (!isActive) {
      charGroupExpanded.set(skin.id, true)
      void activateCharacter(skin.id)
      return
    }
    charGroupExpanded.set(skin.id, !(charGroupExpanded.get(skin.id) ?? true))
    void renderSessions()
  })
  return head
}

/** 一条会话行：标题 + 最后一句预览 + 时间（角色头像在组头上，行内不再重复） */
function buildSessionRow(session: ChatSession): HTMLDivElement {
  const item = document.createElement('div')
  item.className = 'session-item' + (session.id === currentSession?.id ? ' active' : '')
  item.dataset.sid = session.id
  if (batchMode && selectedSessions.has(session.id)) item.classList.add('batch-sel')

  const meta = document.createElement('div')
  meta.className = 's-meta'
  const title = document.createElement('div')
  title.className = 't'
  title.textContent = session.title || '新的对话'
  const lastVisible = [...session.messages].reverse().find((m: ChatMessage) => !m.hidden)
  const preview = document.createElement('div')
  preview.className = 'p'
  preview.textContent = lastVisible
    ? lastVisible.content.trim()
    : session.topic
      ? `话题：${session.topic}`
      : '还没开始聊'
  const time = document.createElement('div')
  time.className = 'time'
  time.textContent = formatTime(session.updatedAt)
  meta.append(title, preview, time)
  const del = document.createElement('button')
  del.className = 'del'
  del.type = 'button'
  del.textContent = '×'
  del.title = '删除会话'

  if (batchMode) {
    // 批量模式：点击条目=切换选中，单个 × 按钮隐藏
    item.addEventListener('click', () => {
      if (selectedSessions.has(session.id)) selectedSessions.delete(session.id)
      else selectedSessions.add(session.id)
      item.classList.toggle('batch-sel', selectedSessions.has(session.id))
      updateBatchBar()
    })
    item.append(meta)
  } else {
    item.append(meta, del)
    item.addEventListener('click', () => void selectSession(session.id))
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      void qqConfirm(`删除会话「${session.title || '新的对话'}」？`).then((ok) => {
        if (!ok) return
        void api.deleteSession(session.id).then(() => {
          if (currentSession?.id === session.id) resetComposer()
          void renderSessions()
        })
      })
    })
  }
  return item
}

async function renderSessions(): Promise<void> {
  const [store, skins] = await Promise.all([api.listSessions(), refreshSkins()])
  const activeId = activeSkinId || skins[0]?.id || 'yeshunguang'
  sessionList.innerHTML = ''

  // 按角色分组：旧数据没有 characterId 的挂当前角色名下；归属皮肤被删的并入当前组（不丢数据）
  const groups: { skin: { id: string; name: string; avatar?: string }; sessions: ChatSession[] }[] = skins.map(
    (skin: { id: string; name: string; avatar?: string }) => ({ skin, sessions: [] })
  )
  const byId = new Map(groups.map((group) => [group.skin.id, group]))
  if (!byId.has(activeId)) {
    const fallback = { skin: { id: activeId, name: activeId }, sessions: [] as ChatSession[] }
    groups.push(fallback)
    byId.set(activeId, fallback)
  }
  for (const session of store.sessions) {
    const id = session.characterId && byId.has(session.characterId) ? session.characterId : activeId
    byId.get(id)!.sessions.push(session)
  }

  for (const group of groups) {
    sessionList.appendChild(buildGroupHead(group.skin, group.skin.id === activeId))
    if (!(charGroupExpanded.get(group.skin.id) ?? true)) continue
    if (group.sessions.length === 0) {
      if (group.skin.id !== activeId) continue
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有会话\n点上面的 ＋ 开个新话题'
      sessionList.appendChild(empty)
      continue
    }
    for (const session of group.sessions) sessionList.appendChild(buildSessionRow(session))
  }
  syncProfileBadge()
}

async function selectSession(id: string): Promise<void> {
  const session: ChatSession | null = await api.openSession(id)
  if (!session) return
  // 点了别的角色的会话：先整体切到那个角色（人设/动画/语音一起换），再展示这段对话
  if (session.characterId && session.characterId !== activeSkinId) {
    await activateCharacter(session.characterId)
  }
  currentSession = session
  showSessionView(session)
  await renderSessions()
}

/** 换角色后聊天窗跟着换人：接上她最近一段会话，没有历史就空窗（下一条消息给她建档）。
 *  主进程 activeSessionId 一并对齐，否则新角色的消息会落进旧角色的会话（对话串台） */
async function handoffSessionOnSwitch(skinId: string): Promise<void> {
  const belongs = (session: ChatSession): boolean => (session.characterId || 'yeshunguang') === skinId
  if (currentSession && belongs(currentSession)) return // 跨角色点会话进来时已经切好了
  const store = await api.listSessions()
  const latest = [...store.sessions].filter(belongs).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (latest) {
    const session = await api.openSession(latest.id)
    if (!session) return
    currentSession = session
    showSessionView(session)
  } else {
    await api.openSession('') // 清主进程活跃会话：下一条消息现场给她建档
    currentSession = null
    removeHomeLive()
    sessionTitleEl.textContent = ''
    sessionWhenEl.textContent = ''
    updateSessionCharBadge().catch(() => {})
    renderEmptyPreview()
  }
}

/** 邀约页联系人卡：一张卡一个角色，点击切换（右侧大卡/话题/通话跟当前角色走） */
async function renderContactCards(): Promise<void> {
  const skins = await refreshSkins()
  contactCards.innerHTML = ''
  for (const skin of skins) {
    const card = document.createElement('div')
    card.className = 'video-contact' + (skin.id === activeSkinId ? ' active' : '')
    card.dataset.skin = skin.id
    const avatar = document.createElement('img')
    avatar.className = 's-avatar'
    avatar.src = skinAvatarSrc(skin)
    avatar.alt = ''
    avatar.draggable = false
    const meta = document.createElement('div')
    meta.className = 's-meta'
    const name = document.createElement('div')
    name.className = 't'
    name.textContent = skin.name || skin.id
    const online = document.createElement('div')
    online.className = 'online'
    online.innerHTML =
      skin.id === activeSkinId
        ? '使用中<span class="o-dots">…</span>'
        : '在线<span class="o-dots">…</span>'
    meta.append(name, online)
    card.append(avatar, meta)
    card.addEventListener('click', () => {
      void activateCharacter(skin.id)
    })
    contactCards.appendChild(card)
  }
}

/** 会话头左侧的角色标识：这段对话属于谁就显示谁（跨角色点会话后自动正确） */
async function updateSessionCharBadge(characterId?: string): Promise<void> {
  if (skinsCache.length === 0) await refreshSkins()
  const skin = skinById(characterId || activeSkinId)
  if (!skin) {
    sessionCharAvatar.classList.add('hidden')
    sessionCharName.textContent = ''
    return
  }
  sessionCharAvatar.src = skinAvatarSrc(skin)
  sessionCharAvatar.classList.remove('hidden')
  sessionCharName.textContent = skin.name || skin.id
}

/** 档案爱心徽标挂在当前角色的组头上，重建列表后按最近状态补挂 */
let profileHasFacts = false
function syncProfileBadge(): void {
  const heart = sessionList.querySelector<HTMLElement>('.char-group-head.active .g-heart')
  heart?.classList.toggle('has-facts', profileHasFacts)
}

let avatarUrl = 'petasset://skin/avatar.png'
bubbleAvatar.src = avatarUrl // 默认头像兜底（applySkin 里会按皮肤刷新）
const USER_AVATAR_SVG =
  '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.3 0-8 1.7-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-3.3-4.7-5-8-5z"/></svg>'

/** 一条聊天记录节点（通话记录面板 / 主界面会话预览共用）：头像 + 气泡 */
function historyMessageNode(message: ChatMessage): HTMLDivElement {
  const row = document.createElement('div')
  row.className = `h-row ${message.role}`

  if (message.role === 'assistant') {
    const avatar = document.createElement('img')
    avatar.className = 'avatar'
    avatar.src = avatarUrl
    avatar.draggable = false
    row.appendChild(avatar)
  } else {
    const avatar = document.createElement('span')
    avatar.className = 'avatar avatar-user'
    avatar.innerHTML = USER_AVATAR_SVG
    row.appendChild(avatar)
  }

  const node = document.createElement('div')
  node.className = `h-msg ${message.role}`
  // trim：老消息里存的正文可能带开头换行（当时未裁），pre-wrap 下会顶出一块空白
  node.textContent = message.content.trim()
  const when = document.createElement('span')
  when.className = 'when'
  when.textContent = formatTime(message.ts)
  node.appendChild(when)
  row.appendChild(node)
  return row
}

// ---------- 敲敲三选项卡：邀约 / 私信 / 群聊 ----------

let currentTab: 'video' | 'chat' | 'group' = 'chat'

/** 按 currentTab 整理主区视图的可见性（聊天窗在私信页常驻，空会话显示 ZZZ 空态） */
function applyTabMain(): void {
  inviteView.classList.toggle('hidden', currentTab !== 'video')
  groupView.classList.toggle('hidden', currentTab !== 'group')
  sessionView.classList.toggle('hidden', currentTab !== 'chat')
  profilePanel.classList.add('hidden')
  // 还没选会话时聊天窗也别留白：给 ZZZ 空态，用户知道往哪儿打字
  if (currentTab === 'chat' && sessionPreview.childElementCount === 0) renderEmptyPreview()
}

function switchTab(tab: 'video' | 'chat' | 'group'): void {
  currentTab = tab
  tabVideo.classList.toggle('on', tab === 'video')
  tabChat.classList.toggle('on', tab === 'chat')
  tabGroup.classList.toggle('on', tab === 'group')
  sideVideo.classList.toggle('hidden', tab !== 'video')
  sideChat.classList.toggle('hidden', tab !== 'chat')
  sideGroup.classList.toggle('hidden', tab !== 'group')
  applyTabMain()
  if (tab === 'video') void loadImpression()
}

/** 邀约卡：印象取自档案记忆的第一条（游戏里是「对某人的印象」） */
async function loadImpression(): Promise<void> {
  const name = skinMeta?.name || '叶瞬光'
  impTitle.textContent = `对${name}的印象：`
  try {
    const profile = await api.getProfile()
    impText.textContent = profile.facts[0]?.text || '聊得多了，这里就会写下对你的印象'
  } catch {
    // 拉不到就保持现状
  }
}

// 邀约 = 发起视频通话（没会话就先按「随便聊聊」建档，她围绕话题接通）
inviteBtn.addEventListener('click', () => {
  void (async () => {
    if (!currentSession) {
      const session = await api.createSession('随便聊聊')
      if (!session) return
      currentSession = session
      await renderSessions()
    }
    await startCall()
  })()
})

// 喜欢的代理人：星标点亮 / 熄灭，状态存配置（设置页保存会原样保留）。
// 这段在模块顶层——任何同步异常都会掐死后面所有接线（三个选项卡、boot 全体阵亡），
// 旧 preload / 半热更新的页面里 api 可能根本没有这两个方法，全部兜底，绝不往外抛。
function renderFavoriteAgent(lit: boolean): void {
  if (!inviteStar) return
  inviteStar.classList.toggle('lit', lit)
  inviteStar.setAttribute('aria-pressed', String(lit))
}

function initFavoriteAgent(): void {
  if (!inviteStar) return
  inviteStar.addEventListener('click', () => {
    const lit = !inviteStar.classList.contains('lit')
    renderFavoriteAgent(lit)
    void api.setFavoriteAgent?.(lit)
  })
  try {
    void api
      .getFavoriteAgent()
      .then(renderFavoriteAgent)
      .catch(() => renderFavoriteAgent(false))
  } catch {
    renderFavoriteAgent(false)
  }
}

initFavoriteAgent()

tabVideo.addEventListener('click', () => switchTab('video'))
tabChat.addEventListener('click', () => switchTab('chat'))
tabGroup.addEventListener('click', () => switchTab('group'))

/** 选中已有会话：右侧直接展示这段对话的内容 */
function showSessionView(session: ChatSession): void {
  profilePanel.classList.add('hidden')
  applyTabMain()
  sessionTitleEl.textContent = session.title || '新的对话'
  sessionWhenEl.textContent = formatTime(session.updatedAt)
  updateSessionCharBadge(session.characterId).catch(() => {}) // 会话头角色标识：这段对话属于谁

  sessionPreview.innerHTML = ''
  removeHomeLive() // 重建列表：上一轮的 live 气泡节点已随 innerHTML 消失，指针同步作废
  const visible: ChatMessage[] = session.messages.filter((m: ChatMessage) => !m.hidden)
  if (visible.length === 0) {
    renderEmptyPreview()
    return
  }
  for (const message of visible) sessionPreview.appendChild(historyMessageNode(message))
  sessionPreview.scrollTop = sessionPreview.scrollHeight
}

/** ZZZ-Chat 式空态：还没有消息 / 开始对话吧 */
function renderEmptyPreview(): void {
  sessionPreview.innerHTML = ''
  const empty = document.createElement('div')
  empty.className = 'empty-zzz'
  empty.innerHTML =
    '<div class="ez-t1">还没有消息。</div>' +
    '<div class="ez-t2">开始对话吧！</div>' +
    '<img class="ez-sticker" src="petasset://assets/icons/knock-knock.svg" alt="" draggable="false" />' +
    '<div class="ez-hint">在下面打一句，她就接上了</div>'
  sessionPreview.appendChild(empty)
}

/** 回到「空聊天窗」状态（下一条消息会现场建档） */
function resetComposer(): void {
  currentSession = null
  removeHomeLive()
  switchTab('chat')
  sessionTitleEl.textContent = ''
  sessionWhenEl.textContent = ''
  updateSessionCharBadge().catch(() => {}) // 空窗期标识回到当前角色
  renderEmptyPreview()
}

/** ＋：开一个新话题并当场切过去——右侧换成空聊天窗，左侧新行亮一下。
 *  从别的角色的组头点 ＋：先整体切到那个角色（会话归属由主进程按当前皮肤盖章） */
async function startNewSession(forSkinId?: string): Promise<void> {
  if (forSkinId && forSkinId !== activeSkinId) await activateCharacter(forSkinId)
  // 已经停在一条还没开口的会话上就直接复用，免得连点堆出一排空会话
  const session =
    currentSession && currentSession.messages.length === 0
      ? currentSession
      : await api.createSession('')
  if (!session) return
  currentSession = session
  charGroupExpanded.set(activeSkinId, true)
  switchTab('chat')
  showSessionView(session)
  await renderSessions()
  const row = sessionList.querySelector<HTMLElement>(`.session-item[data-sid="${session.id}"]`)
  if (row) {
    row.classList.add('just-new')
    setTimeout(() => row.classList.remove('just-new'), 900)
  }
  homeChatInput.value = ''
  homeChatInput.focus()
}

// 换形象入口在设置窗口（底部「设置」按钮）

function syncChips(): void {
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#topic-chips .chip')) {
    chip.classList.toggle('on', !!topicInput.value && chip.textContent === topicInput.value)
  }
}

for (const chip of document.querySelectorAll<HTMLButtonElement>('#topic-chips .chip')) {
  chip.addEventListener('click', () => {
    if (chip.classList.contains('on')) {
      topicInput.value = ''
    } else {
      topicInput.value = chip.textContent ?? ''
    }
    syncChips()
  })
}

topicInput.addEventListener('input', syncChips)

/** 开始/继续通话：新会话先建档，没聊过的由她围绕主题先开口 */
async function startCall(): Promise<void> {
  let session: ChatSession
  if (currentSession) {
    session = currentSession
  } else {
    session = await api.createSession(topicInput.value.trim())
    currentSession = session
  }
  showView('call')

  const visible = session.messages.filter((m: ChatMessage) => !m.hidden)
  const lastAssistant = [...visible].reverse().find((m: ChatMessage) => m.role === 'assistant')
  if (lastAssistant?.content) {
    showBubble(escapeHtml(lastAssistant.content))
    if (lastAssistant.emotion) {
      shownEmotion = lastAssistant.emotion
      player.setEmotion(lastAssistant.emotion)
    }
  } else {
    bubble.classList.add('hidden')
  }
  if (session.messages.length === 0) {
    await api.beginCall() // 她先开口，pet:state 事件会把气泡换成思考中
  }
  input.focus()
}

// 聊天窗里的视频通话按钮（原「继续视频通话」长按钮的继任者）
homeCallBtn.addEventListener('click', () => {
  void startCall()
})

// 话题输入回车 = 直接邀约（带话题的视频通话，空会话时她围绕话题接通）
topicInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  switchTab('video')
  void startCall()
})

/** 主界面聊天窗直接打字：发出去，她照常语音回复（runTurn 与视图无关）。
 *  发送成功才清空输入框；失败把字还回去，避免"点发送直接消失、她没收到" */
async function sendFromHome(): Promise<void> {
  const text = homeChatInput.value.trim()
  if (!text) return
  try {
    if (!currentSession) {
      // 没建档就现场建一个（标题会自动取这条消息），进聊天窗再发
      const session = await api.createSession('')
      if (!session) throw new Error('新建会话失败')
      currentSession = session
      showSessionView(session)
      await renderSessions()
    }
    await api.send(text)
    if (homeChatInput.value.trim() === text) homeChatInput.value = ''
  } catch (error) {
    homeChatInput.value = text
    console.error('[send]', error)
  }
  homeChatInput.focus()
}

homeInputbar.addEventListener('submit', (event) => {
  event.preventDefault()
  void sendFromHome()
})

// ---------- 档案记忆面板：她长期记住的关于你 ----------

async function refreshProfileCount(): Promise<void> {
  const profile = await api.getProfile()
  profileCount.textContent = `${profile.facts.length} 条`
  profileCount.classList.toggle('hidden', profile.facts.length === 0)
  profileHasFacts = profile.facts.length > 0
  syncProfileBadge()
}

async function openProfilePanel(): Promise<void> {
  // 关掉其他视图，档案面板独占右侧
  inviteView.classList.add('hidden')
  groupView.classList.add('hidden')
  sessionView.classList.add('hidden')
  profilePanel.classList.remove('hidden')

  profileList.innerHTML = ''
  const empty = document.createElement('div')
  empty.className = 'empty'
  empty.textContent = '还没有记住什么\n多和她聊聊，她会慢慢认识你'
  profileList.appendChild(empty)

  const profile = await api.getProfile()
  profileList.innerHTML = ''
  await refreshProfileCount()
  if (profile.facts.length === 0) {
    profileList.appendChild(empty)
    return
  }
  for (const fact of profile.facts) {
    const row = document.createElement('div')
    row.className = 'profile-fact'
    const text = document.createElement('span')
    text.className = 'text'
    text.textContent = fact.text
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = formatTime(fact.updatedAt)
    const del = document.createElement('button')
    del.className = 'del'
    del.type = 'button'
    del.textContent = '×'
    del.title = '忘掉这件事'
    del.addEventListener('click', () => {
      void api.deleteProfileFact(fact.id).then(() => void openProfilePanel())
    })
    row.append(text, when, del)
    profileList.appendChild(row)
  }
}

profileClose.addEventListener('click', () => {
  profilePanel.classList.add('hidden')
  applyTabMain()
})

// ---------- 视图切换 / 挂断 ----------

function showView(view: 'home' | 'call'): void {
  currentView = view
  api.notifyView?.(view) // 上报主进程：控制桥的通话端点据此判断通话是否进行中
  if (view === 'call') hideUserToast() // 新通话从干净的对话区开始（上一条提问不残留）
  homeView.classList.toggle('hidden', view !== 'home')
  callView.classList.toggle('hidden', view !== 'call')
  if (view === 'home') {
    historyPanel.classList.remove('open')
    void renderSessions()
    void refreshProfileCount()
    applyTabMain() // 回 home 恢复当前选项卡的主区视图
    if (currentTab === 'chat') homeChatInput.focus()
    else if (currentTab === 'video') topicInput.focus()
  }
}

/** 挂断：停播报，回主界面并刷新这段会话（挂断按钮与控制桥 pet:call-end 共用） */
function hangup(): void {
  void api.stop()
  stopSpeech()
  waveform.classList.remove('on')
  callLabel.textContent = '视频通话中'
  showView('home')
  // 主界面右侧回到这段对话的最新内容（渲染层手里的 session 对象不包含通话中新产生的消息）
  if (currentSession) {
    const id = currentSession.id
    void api.openSession(id).then((fresh) => {
      if (fresh && currentSession?.id === id) {
        currentSession = fresh
        showSessionView(fresh)
      }
    })
  }
}

hangupBtn.addEventListener('click', () => {
  hangup()
})

// ---------- 控制桥发起的通话（DSH 等外部 agent）：主进程指令切视图，不抢焦点 ----------

api.on('pet:call-start', (...args: unknown[]) => {
  const payload = args[0] as { sessionId?: string; topic?: string } | undefined
  if (!payload?.sessionId) return
  void api.openSession(payload.sessionId).then((fresh) => {
    if (fresh) currentSession = fresh // 挂断时的会话刷新要用
  })
  // 新会话还没有可显示的气泡；她的开场白走 runTurn opening，事件流照常推字幕
  bubble.classList.add('hidden')
  revealedText = ''
  pendingChars = 0
  stopReveal()
  workingText = ''
  showView('call')
})

api.on('pet:call-end', () => {
  hangup()
})

// ---------- 通话界面：右侧聊天记录面板 ----------

function renderHistory(): void {
  historyList.innerHTML = ''
  const visible = (currentSession?.messages ?? []).filter((m) => !m.hidden)
  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有聊天记录'
    historyList.appendChild(empty)
    return
  }
  for (const message of visible) historyList.appendChild(historyMessageNode(message))
  historyList.scrollTop = historyList.scrollHeight
}

function renderHistoryIfOpen(): void {
  if (historyPanel.classList.contains('open')) renderHistory()
}

historyToggle.addEventListener('click', () => {
  const opening = !historyPanel.classList.contains('open')
  historyPanel.classList.toggle('open', opening)
  if (opening) renderHistory()
})

historyClose.addEventListener('click', () => historyPanel.classList.remove('open'))

// ---------- 通话设置（语音音量） ----------

async function refreshCallFlags(): Promise<void> {
  try {
    const config = await window.settingsAPI.getConfig()
    const volume = Number(config.tts?.volume)
    if (Number.isFinite(volume)) ttsVolume = Math.min(1, Math.max(0, volume))
    pcm.setVolume(bridgeOwnsAudio ? 0 : ttsVolume)
  } catch {
    // 保持默认
  }
}

// ---------- 输入与拖动 ----------

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text) return
  stopSpeech()
  // 发送成功才清空：主进程重启/热更新导致 invoke 失败时，把字还回输入框并提示，
  // 不然就是"点发送直接消失、她根本没收到"
  api
    .send(text)
    .then(() => {
      if (input.value.trim() === text) input.value = ''
    })
    .catch((error) => {
      input.value = text
      showBubble(escapeHtml(`没发出去：${(error as Error)?.message || '请再试一次'}`), true)
    })
  input.focus()
})

// 点击屏幕（人物区域）：切换待机动画。监听挂 #screen——动画层（canvas/video）
// 设了点击穿透，点击会落到下面的界面元素上，得在这里接并排除可交互 UI
document.getElementById('screen')?.addEventListener('click', (event) => {
  if (currentView !== 'call') return
  if (isInteractiveTarget(event.target)) return
  player.cycleIdle()
})

// 双击平板：摸头反应（屏幕上部）/ 点屏幕反应（其他部位）
document.getElementById('screen')?.addEventListener('dblclick', (event) => {
  if (isInteractiveTarget(event.target)) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const zone = event.clientY - rect.top < rect.height * 0.38 ? 'head' : 'body'
  void api.pat(zone)
})

// 边框拖动：渲染层报起点，主进程轮询光标
document.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement
  if (event.button !== 0 || !target.closest('[data-drag]')) return
  api.startDrag(event.screenX - window.screenX, event.screenY - window.screenY)
  // 指针捕获：拖出窗口后再松手，mouseup 也能送到渲染层（否则拖到窗口外松手，拖动永不结束）
  try {
    ;(target as HTMLElement).setPointerCapture((event as PointerEvent).pointerId)
  } catch {
    // 元素不支持捕获时退化为旧行为（只能在窗口内松手）
  }
  const end = (): void => {
    api.endDrag()
    window.removeEventListener('mouseup', end)
    window.removeEventListener('pointerup', end)
  }
  window.addEventListener('mouseup', end)
  window.addEventListener('pointerup', end)
})

// ---------- 前台自愈 ----------
// Windows 下窗口可能落进"看得见但页面没激活"的死状态（沉底/唤回和全屏游戏
// 抢前台打架）：点输入框没光标、打字全落进别的窗口，用户只能靠截屏切一次
// 前台救活。这里兜底：点击落进页面 120ms 后仍报告失焦，就请主进程补一次
// 激活——这次点击本身已把前台权交给本进程，SetForegroundWindow 必然成功。
document.addEventListener(
  'mousedown',
  () => {
    if (document.hasFocus()) return
    setTimeout(() => {
      if (document.hasFocus()) return
      console.log('[self-heal] 页面失焦但被点击：请求主进程激活窗口')
      api.focusWindow()
      const el = document.activeElement
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.focus()
    }, 120)
  },
  true
)

document.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement
  if (!target.closest('[data-drag]')) return
  event.preventDefault()
  api.contextMenu()
})

// ---------- 启动 ----------

async function boot(): Promise<void> {
  // 窗口还没显示出来时启动视频会被 Chromium 冻结管道，等可见后再开始
  if (document.visibilityState !== 'visible') {
    await new Promise<void>((resolve) => {
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'visible') resolve()
        },
        { once: true }
      )
    })
  }
  await applySkin(true)
  await renderSessions()
  await refreshProfileCount()
  void refreshCallFlags()
  showView('home')
}

void boot()
