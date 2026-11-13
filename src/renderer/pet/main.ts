import type { ChatMessage, ChatSession, SkinMeta } from '../../shared/types'
import { Live2DPlayer } from './Live2DPlayer'
import { AnimationPlayer } from './AnimationPlayer'
import { PcmPlayer } from './PcmPlayer'

const api = window.petAPI

const bubble = document.getElementById('bubble') as HTMLDivElement
const bubbleText = document.getElementById('bubble-text') as HTMLSpanElement
const userToast = document.getElementById('user-toast') as HTMLDivElement
const waveform = document.getElementById('waveform') as HTMLElement
const callLabel = document.getElementById('call-label') as HTMLElement
const form = document.getElementById('inputbar') as HTMLFormElement
const input = document.getElementById('chat-input') as HTMLInputElement
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement

const homeView = document.getElementById('home-view') as HTMLDivElement
const callView = document.getElementById('call-view') as HTMLDivElement
const sessionList = document.getElementById('session-list') as HTMLDivElement
const newSessionBtn = document.getElementById('new-session-btn') as HTMLButtonElement
const topicInput = document.getElementById('topic-input') as HTMLInputElement

const topicView = document.getElementById('topic-view') as HTMLDivElement
const sessionView = document.getElementById('session-view') as HTMLDivElement
const sessionTitleEl = document.getElementById('session-title') as HTMLSpanElement
const sessionWhenEl = document.getElementById('session-when') as HTMLSpanElement
const sessionPreview = document.getElementById('session-preview') as HTMLDivElement

const profileBtn = document.getElementById('profile-btn') as HTMLButtonElement
const profileCount = document.getElementById('profile-count') as HTMLSpanElement
const profilePanel = document.getElementById('profile-panel') as HTMLDivElement
const profileClose = document.getElementById('profile-close') as HTMLButtonElement
const profileList = document.getElementById('profile-list') as HTMLDivElement

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

/** 拉当前皮肤包并（重建）渲染器。id 没变则跳过；force=启动/手动 */
async function applySkin(force = false): Promise<void> {
  let meta: SkinMeta | null = null
  try {
    meta = (await (await fetch(`petasset://skin/skin.json?ts=${Date.now()}`)).json()) as SkinMeta
  } catch {
    // 主进程路由兜底 assets 根：旧布局也能跑
  }
  if (!meta?.id) return
  if (!force && meta.id === activeSkinId) return
  activeSkinId = meta.id
  skinMeta = meta
  const base = 'petasset://skin'
  const container = document.getElementById('char-layer') as HTMLElement
  container.innerHTML = '' // 清掉上一后端的 canvas/video/img
  player.cancelFinishTimer()
  player = meta.backend === 'live2d'
    ? new Live2DPlayer(container, meta, base, () => pcm.level())
    : new AnimationPlayer(container, base)
  avatarUrl = `${base}/${meta.avatar}`
  const wp = document.getElementById('wallpaper') as HTMLImageElement
  if (meta.wallpaper) {
    wp.src = `${base}/${meta.wallpaper}`
    wp.classList.remove('hidden')
  } else {
    wp.removeAttribute('src')
    wp.classList.add('hidden')
  }
  await player.init()
}

let workingText = ''
/** 字幕模式已出的字：每句音频到达时由 pet:sentence 逐句追加，跟着声音走 */
let revealedText = ''
let shownEmotion: string | null = null
/** 本轮是否真的播出过音频：合成失败时不播出场过渡 */
let hadAudioThisTurn = false
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
    'button, input, textarea, #call-bar, #statusbar, #bubble, #user-toast, #history-panel, #home-view, #profile-panel'
  )
}

function showBubble(html: string, isError = false): void {
  bubble.classList.remove('hidden')
  bubble.classList.toggle('error', isError)
  bubbleText.innerHTML = html
  bubble.scrollTop = bubble.scrollHeight
}

function showThinking(): void {
  showBubble('<span class="dots"><i></i><i></i><i></i></span>')
}

function showUserToast(text: string): void {
  userToast.textContent = text
  userToast.classList.remove('hidden', 'fade')
  if (userToastTimer) clearTimeout(userToastTimer)
  userToastTimer = setTimeout(() => {
    userToast.classList.add('fade')
    setTimeout(() => userToast.classList.add('hidden'), 700)
  }, 3600)
}

// ---------- 事件接线 ----------

api.on('pet:state', (state) => {
  if (state === 'thinking') {
    revealedText = ''
    showThinking()
  }
})

api.on('pet:user-message', (text) => {
  showUserToast(String(text))
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
  renderHistoryIfOpen()
})

/** 主进程每落盘一条消息就推过来：追加进当前会话，通话记录面板实时长出来（不用等挂断刷新） */
api.on('pet:message', (payload) => {
  const { sessionId, message } = payload as { sessionId: string; message: ChatMessage }
  if (!currentSession || currentSession.id !== sessionId) return
  currentSession.messages.push(message)
  renderHistoryIfOpen()
})

// ---------- 说话状态看门狗 ----------

/** 逐句合成的最大正常间隔：GSV 单句超时 60s + 重采样，90s 收不到任何语音事件才算卡死 */
const TALK_WATCHDOG_MS = 90_000
let talkWatchdogTimer: ReturnType<typeof setTimeout> | null = null

/** tts-end 迟迟不来（主进程卡在某个永不返回的请求上）时她会永远停在说话动画里，
 *  这里兜底强制收口回待机。正常情况下 tts-end / interrupt 会先把它清掉 */
function armTalkWatchdog(): void {
  if (talkWatchdogTimer) clearTimeout(talkWatchdogTimer)
  talkWatchdogTimer = setTimeout(() => {
    talkWatchdogTimer = null
    if (!hadAudioThisTurn) return
    waveform.classList.remove('on')
    callLabel.textContent = '视频通话中'
    stopVad()
    player.finishTalkingAt(0)
  }, TALK_WATCHDOG_MS)
}

function clearTalkWatchdog(): void {
  if (talkWatchdogTimer) {
    clearTimeout(talkWatchdogTimer)
    talkWatchdogTimer = null
  }
}

api.on('pet:tts-preload', () => {
  // 第一句开始合成：提前把要用的说话片段载入隐藏层，开口时零等待
  player.preloadTalk()
})

api.on('pet:tts-start', () => {
  waveform.classList.add('on')
  callLabel.textContent = '正在说话'
  hadAudioThisTurn = false
  player.setTalking(true)
  armTalkWatchdog()
  // 她开口后稍等片刻再架起人声监听（barge-in）：避开过渡与首帧爆音
  if (bargeArmTimer) clearTimeout(bargeArmTimer)
  bargeArmTimer = setTimeout(armBargeIn, 700)
})

api.on('pet:tts-chunk', (chunk) => {
  hadAudioThisTurn = true
  pcm.pushChunk(String(chunk))
  armTalkWatchdog() // 每块音频都重新计时；90s 一个事件都没有说明主进程卡住了
})

api.on('pet:interrupt', () => {
  // 被新消息打断：清音频/文字缓存和未触发的收口，画面由新回复的说话动画接管
  pcm.stop()
  workingText = ''
  revealedText = ''
  hadAudioThisTurn = false
  clearTalkWatchdog()
  player.cancelFinishTimer()
  stopVad()
})

api.on('pet:tts-end', () => {
  clearTalkWatchdog()
  waveform.classList.remove('on')
  callLabel.textContent = '视频通话中'
  stopVad()
  if (!hadAudioThisTurn) {
    // 本轮从未出声（合成失败等）：直接回待机，不播出场过渡
    player.setTalking(false)
    return
  }
  // 收口倒排：按音频时间线还剩多久播完，提前留出过渡，语音结束瞬间正好闭嘴过渡到待机
  player.finishTalkingAt(pcm.remainingMs)
})

api.on('pet:tts-error', (message) => {
  showBubble(escapeHtml(`（语音没播出来：${String(message)}）`), true)
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => bubble.classList.add('hidden'), 6000)
})

api.on('pet:error', (message) => {
  const text = String(message)
  const hint = /API key|401|Unauthorized/i.test(text)
    ? `先去设置里把 API Key 配好：${text}`
    : `这轮没连上：${text}`
  showBubble(escapeHtml(hint), true)
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => bubble.classList.add('hidden'), 10000)
})

api.on('pet:config-changed', () => {
  void refreshCallFlags()
  void applySkin() // 皮肤可能换了：id 变了才重建渲染器
})

// 控制桥上有远程面板（DSH 里的内嵌通话卡）接管声音时，平板这边静音，免得双声道；
// 只关音量不停播报：动画/口型/状态机照常，面板一关声音自动还回来
let bridgeOwnsAudio = false
api.on('pet:bridge-audio-sink', (on) => {
  bridgeOwnsAudio = on === true
  pcm.setVolume(bridgeOwnsAudio ? 0 : 1)
})

// ---------- 灵动岛（独立岛窗口）----------

/** 主进程闲置计时到点请求收起平板：守卫不过（录音中/她在播）静默忽略，主进程稍后重试 */
api.on('pet:tablet-hide-request', () => {
  if (pcm.busy) return
  stopVad() // 人都不在了，收起就别再占着麦克风监听
  player.pauseAll()
  void api.applyTabletHide()
})

/** 从岛卡片唤回平板：恢复动画 */
api.on('pet:tablet-shown', () => {
  player.resumeAll()
})

/** 岛卡片「开始聊天」：聚焦输入框 */
api.on('pet:island-focus-chat', () => {
  if (currentView === 'call') input.focus()
  else topicInput.focus()
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

async function renderSessions(): Promise<void> {
  const store = await api.listSessions()
  sessionList.innerHTML = ''
  if (store.sessions.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有会话\n定个话题，打给瞬光吧'
    sessionList.appendChild(empty)
    return
  }
  for (const session of store.sessions) {
    const item = document.createElement('div')
    item.className = 'session-item' + (session.id === currentSession?.id ? ' active' : '')

    const title = document.createElement('div')
    title.className = 't'
    title.textContent = session.title || '新的对话'
    const time = document.createElement('div')
    time.className = 'time'
    time.textContent = formatTime(session.updatedAt)
    const del = document.createElement('button')
    del.className = 'del'
    del.type = 'button'
    del.textContent = '×'
    del.title = '删除会话'

    item.append(title, time, del)
    item.addEventListener('click', () => void selectSession(session.id))
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!window.confirm(`删除会话「${session.title || '新的对话'}」？`)) return
      void api.deleteSession(session.id).then(() => {
        if (currentSession?.id === session.id) resetComposer()
        void renderSessions()
      })
    })
    sessionList.appendChild(item)
  }
}

async function selectSession(id: string): Promise<void> {
  const session: ChatSession | null = await api.openSession(id)
  if (!session) return
  currentSession = session
  showSessionView(session)
  await renderSessions()
}

let avatarUrl = 'petasset://assets/avatar.png'
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

/** 选中已有会话：右侧直接展示这段对话的内容 */
function showSessionView(session: ChatSession): void {
  topicView.classList.add('hidden')
  profilePanel.classList.add('hidden')
  sessionView.classList.remove('hidden')
  sessionTitleEl.textContent = session.title || '新的对话'
  sessionWhenEl.textContent = formatTime(session.updatedAt)
  topicInput.value = session.topic
  syncChips()

  sessionPreview.innerHTML = ''
  const visible: ChatMessage[] = session.messages.filter((m: ChatMessage) => !m.hidden)
  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = session.topic
      ? `主题「${session.topic}」还没开始\n点下面打给她`
      : '这次通话还没开始\n点下面打给她'
    sessionPreview.appendChild(empty)
    return
  }
  for (const message of visible) sessionPreview.appendChild(historyMessageNode(message))
  sessionPreview.scrollTop = sessionPreview.scrollHeight
}

/** 回到「新会话定主题」状态 */
function resetComposer(): void {
  currentSession = null
  topicInput.value = ''
  syncChips()
  profilePanel.classList.add('hidden')
  sessionView.classList.add('hidden')
  topicView.classList.remove('hidden')
}

function syncChips(): void {
  for (const chip of document.querySelectorAll<HTMLButtonElement>('#topic-chips .chip')) {
    chip.classList.toggle('on', !!topicInput.value && chip.textContent === topicInput.value)
  }
}

newSessionBtn.addEventListener('click', () => {
  resetComposer()
  void renderSessions()
  topicInput.focus()
})

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

document.getElementById('start-call-btn')?.addEventListener('click', () => {
  void startCall()
})

document.getElementById('resume-call-btn')?.addEventListener('click', () => {
  void startCall()
})

// ---------- 档案记忆面板：她长期记住的关于你 ----------

async function refreshProfileCount(): Promise<void> {
  const profile = await api.getProfile()
  profileCount.textContent = String(profile.facts.length)
  profileCount.classList.toggle('hidden', profile.facts.length === 0)
}

async function openProfilePanel(): Promise<void> {
  // 关掉另外两个视图，档案面板独占右侧
  topicView.classList.add('hidden')
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

profileBtn.addEventListener('click', () => void openProfilePanel())
profileClose.addEventListener('click', () => {
  profilePanel.classList.add('hidden')
  if (currentSession) showSessionView(currentSession)
  else {
    topicView.classList.remove('hidden')
    sessionView.classList.add('hidden')
  }
})

// ---------- 视图切换 / 挂断 ----------

function showView(view: 'home' | 'call'): void {
  currentView = view
  api.notifyView?.(view) // 上报主进程：控制桥的通话端点据此判断通话是否进行中
  homeView.classList.toggle('hidden', view !== 'home')
  callView.classList.toggle('hidden', view !== 'call')
  if (view === 'home') {
    historyPanel.classList.remove('open')
    void renderSessions()
    void refreshProfileCount()
    topicInput.focus()
  }
}

/** 挂断：停录音/VAD/播报，回主界面并刷新这段会话（挂断按钮与控制桥 pet:call-end 共用） */
function hangup(): void {
  stopVad()
  void api.stop()
  pcm.stop()
  player.cancelFinishTimer()
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

// ---------- 通话中打断（barge-in）：她说话时你开口，她立即停下沉听 ----------

const VAD_LOUD = 0.055 // 持续高于它 ≈ 你在说话
const VAD_QUIET = 0.03 // 低于它 ≈ 说完了
const VAD_LOUD_MS = 320 // 防单帧噪声：要持续响这么久才算真的开口
const VAD_SILENCE_MS = 1400 // 说完后静默这么久自动收音
const VAD_MIN_SPEECH_MS = 700 // 至少说这么久才收音（太短≈误触）

let bargeInEnabled = true
let bargeArmTimer: ReturnType<typeof setTimeout> | null = null
let vadStream: MediaStream | null = null
let vadTimer: ReturnType<typeof setInterval> | null = null
let vadLoudSince = 0

async function refreshCallFlags(): Promise<void> {
  try {
    const config = await window.settingsAPI.getConfig()
    bargeInEnabled = config.call?.bargeIn !== false
  } catch {
    // 保持默认
  }
}

/** 释放监听流和计时器 */
function stopVad(): void {
  if (bargeArmTimer) {
    clearTimeout(bargeArmTimer)
    bargeArmTimer = null
  }
  if (vadTimer) {
    clearInterval(vadTimer)
    vadTimer = null
  }
  if (vadStream) {
    vadStream.getTracks().forEach((track) => track.stop())
    vadStream = null
  }
  vadLoudSince = 0
}

function armBargeIn(): void {
  if (!bargeInEnabled || currentView !== 'call') return
  void (async () => {
    try {
      vadStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true } // 回声消除：别把她的声音当成人声
      })
    } catch {
      return
    }
    if (!vadStream || currentView !== 'call') {
      vadStream?.getTracks().forEach((track) => track.stop())
      vadStream = null
      return
    }
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(vadStream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    vadLoudSince = 0
    vadTimer = setInterval(() => {
      if (!vadStream) return
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      const rms = Math.sqrt(sum / buf.length)
      if (rms > VAD_LOUD) {
        if (!vadLoudSince) vadLoudSince = Date.now()
        if (Date.now() - vadLoudSince >= VAD_LOUD_MS) {
          // 你开口了：切断她的音频让位。语音输入已移除——打断只停她，不再录音转写
          const stream = vadStream
          vadStream = null
          if (vadTimer) {
            clearInterval(vadTimer)
            vadTimer = null
          }
          vadLoudSince = 0
          void ctx.close().catch(() => undefined)
          stream?.getTracks().forEach((track) => track.stop())
          pcm.stop()
          void api.stop() // 主进程取消整轮，pet:interrupt 会清画面状态
        }
      } else {
        vadLoudSince = 0
      }
    }, 60)
  })()
}

// ---------- 输入与拖动 ----------

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  pcm.stop() // 她还在说上一句时直接切到新对话
  void api.send(text)
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
