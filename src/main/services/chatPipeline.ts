import { BrowserWindow } from 'electron'
import { AppConfig, ChatMessage, EMOTION_TAG_RE, EMOTIONS } from '../../shared/types'
import { streamChat, systemPrompt } from './llm'
import { synthesizePcm, isTtsReady, TTSError } from './tts'
import { loadSessions, saveSessions, newSession, truncate, activeSkinDir } from './store'
import { profilePrompt, updateProfileFromConversation, dialogueForExtraction } from './profile'
import { recallForTurn, scheduleSummary } from './memory'
import { scheduleMoodUpdate } from './mood'
import { dshActivityPrompt } from './dshActivity'
import { findMeme } from './memewiki'
import { getActiveSessionId, setActiveSession } from './sessionState'
import { getIslandWindow } from '../islandWindow'
import { emitPetEvent } from './petEvents'

type PetSend = (channel: string, ...args: unknown[]) => void

/** 一轮对话的运行态：负责取消 */
let activeTurn: { abort: AbortController } | null = null

export function cancelActiveTurn(petSend?: PetSend): void {
  activeTurn?.abort.abort()
  activeTurn = null
  // 只停音频，不动画面/状态：紧接着的新回复会直接接管说话动画
  // （这里若发 tts-end，渲染层会误触发一次收势，出现"连做两个放下手动作"的怪相）
  petSend?.('pet:interrupt')
}

function toPet(window: BrowserWindow | null): PetSend {
  return (channel, ...args) => {
    emitPetEvent(channel, args) // 分接给控制桥（WS 远程视图同步看字幕/情绪/音频块）
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, ...args)
    }
    // 扇出给灵动岛窗口：状态点（思考/说话）、最近消息、弹跳提示都靠这批事件
    const island = getIslandWindow()
    if (island && !island.isDestroyed() && !island.webContents.isDestroyed()) {
      island.webContents.send(channel, ...args)
    }
  }
}

const SENTENCE_END = /[。！？!?…；;\n~～]/
const SOFT_BREAK = /[，,、：:——]/

/** 一条消息已进会话：推给渲染层，通话记录面板实时长出来（不用等挂断刷新） */
function announceMessage(send: PetSend, sessionId: string, message: ChatMessage): void {
  send('pet:message', { sessionId, message })
}

/** 含有可发音内容（汉字/假名/谚文/字母数字）才送去合成，纯标点表情会别本地服务拒绝 */
const SPEAKABLE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[a-zA-Z0-9]/u

/**
 * 增量分句器：流式文本进来，攒够一句（句末标点 / 长度过限）就吐一句。
 */
export class SentenceSplitter {
  private buffer = ''

  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    for (;;) {
      const sentence = this.next(false)
      if (sentence === null) break
      out.push(sentence)
    }
    return out
  }

  flush(): string[] {
    const out: string[] = []
    for (;;) {
      const sentence = this.next(true)
      if (sentence === null) break
      out.push(sentence)
    }
    return out
  }

  private next(force: boolean): string | null {
    const buf = this.buffer
    if (!buf) return null

    if (!force) {
      const match = SENTENCE_END.exec(buf)
      if (!match) {
        // 没有句末标点但已经太长：在最近的逗号处断句，避免等待过久
        if (buf.length < 80) return null
        const head = buf.slice(0, 80)
        let cut = -1
        for (const m of head.matchAll(SOFT_BREAK)) cut = m.index + 1
        if (cut <= 0) cut = 80
        this.buffer = buf.slice(cut)
        return buf.slice(0, cut)
      }
      const end = match.index + 1
      this.buffer = buf.slice(end)
      return buf.slice(0, end)
    }

    this.buffer = ''
    return buf
  }
}

export function extractEmotion(text: string): { display: string; emotion: string } {
  let emotion = 'neutral'
  for (const match of text.matchAll(EMOTION_TAG_RE)) {
    const name = match[1]
    if ((EMOTIONS as readonly string[]).includes(name)) emotion = name
  }
  // trim：模型习惯在情绪标签后空两行再写正文，标签剥离后残留的开头换行会让气泡顶部一大块空白
  return { display: text.replace(EMOTION_TAG_RE, '').trim(), emotion }
}

export interface TurnOptions {
  petWindow: BrowserWindow | null
  config: AppConfig
  /** 目标会话 */
  sessionId: string
  /** 用户这轮说的话（正常发言） */
  text?: string
  /** 开场指令：通话刚接通由她先开口（作为隐藏用户消息写进上下文，不在界面出现） */
  opening?: string
  /** 远程来源（DSH 面板 / agent 桥接）：她已在远程面板里现身，桌面平板保持原状不弹出 */
  remote?: boolean
  /** 她的完整回复落盘时回调（控制桥 /chat 等外部调用方拿回复文本用；取消/失败不触发） */
  onAssistant?: (text: string, emotion: string) => void
  /** 本轮彻底收尾时回调（成功/失败都会触发；onAssistant 之后仍会触发一次） */
  onEnd?: () => void
}

/** 通话开场指令：让模型以她自己的口吻先开口，围绕主界面定的主题展开 */
function openingMessage(topic: string): ChatMessage {
  const guide = topic
    ? `（视频通话刚接通。这次想聊的主题是「${topic}」。请你先开口：自然地打个招呼，围绕这个主题开启话题，也可以先关心一下对方现在的状态。）`
    : '（视频通话刚接通。请你先开口打个招呼，自然地问问对方今天过得怎么样。）'
  return { role: 'user', content: guide, ts: Date.now(), hidden: true }
}

/**
 * 一轮完整对话：取消上一轮 → LLM 流式 → 分句 TTS → 情绪推送 → 会话落盘。
 */
export async function runTurn(options: TurnOptions): Promise<void> {
  const send = toPet(options.petWindow)
  cancelActiveTurn(send)
  cancelPat(send) // 摸头反应还在说：直接切到新对话
  // 平板收成灵动岛时不弹出：岛窗口会收到这批事件（弹跳 + 状态点 + 最近消息）

  const abort = new AbortController()
  activeTurn = { abort }

  const store = loadSessions()
  const session = store.sessions.find((s) => s.id === options.sessionId)
  if (!session) return

  if (typeof options.opening === 'string') {
    const opening = openingMessage(options.opening)
    session.messages.push(opening)
    announceMessage(send, session.id, opening) // hidden 消息面板不展示，但保持渲染层内存同步
  } else if (options.text) {
    const userMessage: ChatMessage = { role: 'user', content: options.text, ts: Date.now() }
    session.messages.push(userMessage)
    announceMessage(send, session.id, userMessage)
    send('pet:user-message', options.text)
  } else {
    return
  }
  // 第一条真实发言出现后，拿它当会话标题（开场指令不算）
  if (!session.title) {
    const firstUser = session.messages.find((m) => m.role === 'user' && !m.hidden)
    session.title = firstUser ? truncate(firstUser.content, 18) : truncate(session.topic, 18) || '新的对话'
  }
  session.updatedAt = Date.now()
  send('pet:state', 'thinking')

  const splitter = new SentenceSplitter()
  let firstSentenceRevealed = false // 首句不等音频：LLM 慢时先让字出来
  let full = ''
  let speaking = false
  let speakStartAt = 0
  let emotionSent = false
  /** 本轮是否真的播出了音频：有音频时说话动画完全跟音频走 */
  let audioStarted = false
  const ttsReady = isTtsReady(options.config.tts)
  /** 字幕模式（配了语音）：文字不随 LLM 流式上屏，等这句的音频到达才出字——边说边吐字 */
  const subtitleMode = ttsReady

  // 说话动画的开始：
  // - 配了语音：等第一个音频块到达才开始（避免"文字出来了嘴先动、声音晚两秒"）
  // - 没配语音：LLM 出第一个字就算在说话（按朗读时长撑动画）
  const beginSpeak = (): void => {
    if (speaking) return
    speaking = true
    speakStartAt = Date.now()
    send('pet:tts-start')
  }

  const speak = async (sentence: string): Promise<void> => {
    const clean = sentence.replace(EMOTION_TAG_RE, '').trim()
    if (!clean) return
    if (!SPEAKABLE.test(clean)) {
      // 念不出来的纯标点也要上屏，不然字幕缺字
      if (subtitleMode) send('pet:sentence', clean)
      return
    }
    if (!ttsReady) return
    let revealed = false
    const reveal = (): void => {
      if (revealed) return
      revealed = true
      // 第二参=这句的预估语音时长（中文 ≈160ms/字）：渲染层打字机按它配速，文字跟着声音吐
      const estimate = Math.min(15000, Math.max(600, Math.round(clean.length * 160)))
      send('pet:sentence', clean, estimate)
    }
    try {
      // 合成要花两三秒：提前让渲染层把要用的说话片段载好，声音一响嘴立即跟上
      send('pet:tts-preload')
      // 首句抢跑：不等音频（TTS 合成还要 1~3 秒，智谱慢的时候 LLM 本身就几十秒），
      // 字先打出来，声音随后到；后续句仍等首音频块、边说边吐字
      if (!firstSentenceRevealed) {
        firstSentenceRevealed = true
        reveal()
      }
      await synthesizePcm(options.config.tts, clean, {
        signal: abort.signal,
        onChunk: (pcm) => {
          if (!audioStarted) {
            audioStarted = true
            beginSpeak()
          }
          // 这句的第一个音频块到达：声音马上要响，字跟着出
          reveal()
          send('pet:tts-chunk', pcm.toString('base64'))
        }
      })
      // 合成完成但一个块都没来过（比如整句被本地服务拒绝）：字直接上，别丢
      reveal()
    } catch (error) {
      if ((error as TTSError).message === '已取消') return
      console.error('[tts]', error)
      reveal() // 合成失败字也要出现，只是没声音
      send('pet:tts-error', (error as Error).message)
    }
  }

  // 分句按顺序排队合成，保证音频块到达顺序与文本一致；文字显示不受排队影响
  let chain: Promise<void> = Promise.resolve()
  const enqueueSpeak = (sentence: string): void => {
    chain = chain.then(() => speak(sentence))
  }

  try {
    // 问梗预查（梗百科词库）：命中就在模型看到前把词条塞进上下文，让她直接接梗不硬猜
    const memeHit = options.text ? await findMeme(options.text).catch(() => null) : null
    // 两种意图两种措辞：求解释→点破即可；玩梗/用梗→顺着接，绝不解释定义
    let memeBlock = ''
    if (memeHit?.found && memeHit.title) {
      let guide: string
      if (memeHit.ritual) {
        guide = `你们正在玩梗「${memeHit.title}」的接龙暗号！这个梗的标准接法是「${memeHit.chain}」。轮到你了：把接龙的下句用你自己的口吻接出来（可以带点戏精感），别解释、别认输`
      } else if (memeHit.asked) {
        guide = `用户在问梗「${memeHit.title}」是什么。先用一两句你自己的话把梗点破（别照念条目），然后照常接住用户继续聊${
          memeHit.chain ? `。另外词条里写了这个梗的标准接法是「${memeHit.chain}」——如果对话里出现合适的时机（比如对方说「${memeHit.chain.split(/\s+/)[0]}」），要用接法玩下去` : ''
        }`
      } else {
        guide = `用户在玩梗/用梗：「${memeHit.title}」（背景：${memeHit.entry}）。千万别解释这个梗的定义或来历，直接顺着梗接话、玩回去${
          memeHit.chain ? `。标准接法是「${memeHit.chain}」，时机合适就用` : ''
        }`
      }
      memeBlock = `

[梗百科] ${guide}`
    }
    // 每轮注入：人设（随皮肤）+ 梗百科 + 档案记忆 + 语义召回的旧回忆 + DSH 实时动态（用户问"他在干嘛"时她照着讲）
    const system =
      systemPrompt(activeSkinDir(options.config)) +
      memeBlock +
      profilePrompt() +
      (await recallForTurn(options.config.llm, options.text ?? '', options.sessionId)) +
      dshActivityPrompt()
    const streamed = await streamChat({
      config: options.config.llm,
      system,
      history: session.messages,
      signal: abort.signal,
      onDelta: (delta) => {
        full += delta
        // 没配语音时文字一出就进入说话状态；配了语音则由音频块触发
        if (!ttsReady) beginSpeak()
        // 字幕模式下文字不走流式上屏（由 pet:sentence 按句跟随语音）
        if (!subtitleMode) send('pet:llm-delta', delta)
        // 情绪标签在回复开头：流式过程中一出现就推送，让她"先做出反应再说话"
        if (!emotionSent) {
          const m = /^\s*\[(?:emotion:)?([a-z_]+)\]/.exec(full)
          if (m && (EMOTIONS as readonly string[]).includes(m[1])) {
            emotionSent = true
            send('pet:emotion', m[1])
          }
        }
        for (const sentence of splitter.push(delta)) enqueueSpeak(sentence)
      }
    })
    // 流结束后补上最后不足一句的内容
    enqueueSpeak(splitter.flush().join(''))

    const { display, emotion } = extractEmotion(streamed)
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: display,
      emotion,
      ts: Date.now()
    }
    session.messages.push(assistantMessage)
    session.updatedAt = Date.now()
    announceMessage(send, session.id, assistantMessage)
    saveSessions(store)
    options.onAssistant?.(display, emotion) // 回复已定稿，外部调用方（控制桥 /chat）可拿走了
    scheduleProfileExtraction(options.sessionId, options.config.llm)
    scheduleSummary(options.sessionId, options.config.llm)
    scheduleMoodUpdate(options.config.llm)

    // 字幕模式下正文由 pet:sentence 逐句出过了，这里只带情绪，避免整段文字瞬间跳出来
    send('pet:llm-done', { text: subtitleMode ? '' : display, emotion })
    await chain
    // 只有本轮没播出任何音频（没配语音或合成全失败）才按朗读时长兜底撑动画；
    // 有音频时渲染层等缓冲播完就收，动画严格跟着声音走，不多动一帧
    if (!audioStarted) {
      const chars = display.replace(/\s/g, '').length
      const estimateMs = Math.min(45_000, Math.max(1_600, chars * 270))
      const holdMs = Math.max(0, estimateMs - (Date.now() - speakStartAt))
      if (holdMs > 0) {
        const hold = new Promise<void>((resolve) => setTimeout(resolve, holdMs))
        const cancelled = new Promise<void>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        await Promise.race([hold, cancelled])
      }
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (message !== '已取消') {
      console.error('[llm]', error)
      send('pet:error', message)
      // 流中断时她已经说出口的半截话也要落盘：不然上下文里"她说过"的内容凭空消失
      const { display, emotion } = extractEmotion(full)
      if (display) {
        const partial: ChatMessage = { role: 'assistant', content: display, emotion, ts: Date.now() }
        session.messages.push(partial)
        session.updatedAt = Date.now()
        saveSessions(store)
        announceMessage(send, session.id, partial)
      }
    }
    await chain.catch(() => undefined)
  } finally {
    if (activeTurn?.abort === abort) {
      send('pet:tts-end')
      send('pet:state', 'idle')
      activeTurn = null
    }
    options.onEnd?.()
  }
}

// ---------- 摸摸头互动（双击平板：短语 + TTS 反应，不走 LLM） ----------

const PAT_LINES: Record<'head' | 'body', string[]> = {
  head: [
    '唔…突然摸头什么的，犯规了吧。',
    '头发都要被你揉乱了啦…笨蛋。',
    '…就、就再让你摸一下下。',
    '嘿嘿…你的手好暖。',
    '哼，摸舒服了？那也不能天天摸。'
  ],
  body: [
    '戳什么戳，屏幕又不会坏…好啦好啦，在的在的。',
    '喂，手指还在屏幕上呢。',
    '再戳我就要当场表演一个歪头了哦。',
    '怎么啦怎么啦，想我了？',
    '指指点点地…好了好了，说吧，我听着呢。'
  ]
}

let lastPatLine = ''
/** 摸头反应运行态（不占 activeTurn，但要能被新对话打断） */
let patAbort: AbortController | null = null

export function isPatActive(): boolean {
  return patAbort !== null
}

export function isTurnActive(): boolean {
  return activeTurn !== null
}

export function cancelPat(petSend?: PetSend): void {
  if (!patAbort) return
  patAbort.abort()
  patAbort = null
  petSend?.('pet:interrupt')
}

/** 双击反应：按部位选短语 + 情绪（决定说话风格动画），TTS 走原事件流，写入会话作隐藏上下文 */
export async function petPat(petWindow: BrowserWindow | null, config: AppConfig, zone: 'head' | 'body'): Promise<void> {
  if (activeTurn || patAbort) return
  const pool = PAT_LINES[zone]
  let line = pool[Math.floor(Math.random() * pool.length)]
  if (line === lastPatLine) line = pool[(pool.indexOf(line) + 1) % pool.length]
  lastPatLine = line

  const send = toPet(petWindow)
  const signal = new AbortController()
  patAbort = signal
  const emotion = zone === 'head' ? 'shy' : 'playful'
  let audioStarted = false
  let revealed = false
  const reveal = (): void => {
    if (revealed) return
    revealed = true
    send('pet:sentence', line)
  }

  try {
    send('pet:state', 'thinking') // 重置字幕缓冲，气泡先出思考点
    send('pet:emotion', emotion)
    if (isTtsReady(config.tts)) {
      send('pet:tts-preload')
      try {
        await synthesizePcm(config.tts, line, {
          signal: signal.signal,
          onChunk: (pcm) => {
            if (!audioStarted) {
              audioStarted = true
              send('pet:tts-start')
              reveal()
            }
            send('pet:tts-chunk', pcm.toString('base64'))
          }
        })
      } catch (error) {
        if ((error as TTSError).message === '已取消') return
        console.error('[tts]', error)
        reveal()
        send('pet:tts-error', (error as Error).message)
      }
    }
    if (!audioStarted) {
      send('pet:tts-start')
      reveal()
      // 没出声（未配语音/合成失败）：按朗读时长撑一下反应动画
      const holdMs = Math.min(8000, Math.max(1600, line.length * 270))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, holdMs)
        signal.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }
    persistExchange(zone === 'head' ? '（用户摸了摸你的头）' : '（用户点了点你的屏幕）', line, emotion, send)
  } finally {
    const cancelled = signal.signal.aborted
    patAbort = null
    if (!cancelled) send('pet:tts-end')
  }
}

/** 把「隐藏用户消息 + 真实回复」的形状写进最近的会话，保持上下文连贯（摸头反应 / 插件播报共用） */
function persistExchange(hiddenUser: string, line: string, emotion: string, send?: PetSend): void {
  try {
    const store = loadSessions()
    const session =
      store.sessions.find((s) => s.id === getActiveSessionId()) ??
      [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!session) return
    const hiddenMessage: ChatMessage = {
      role: 'user',
      content: hiddenUser,
      ts: Date.now(),
      hidden: true
    }
    session.messages.push(hiddenMessage)
    const reply: ChatMessage = { role: 'assistant', content: line, emotion, ts: Date.now() }
    session.messages.push(reply)
    session.updatedAt = Date.now()
    saveSessions(store)
    if (send) {
      announceMessage(send, session.id, hiddenMessage)
      announceMessage(send, session.id, reply)
    }
  } catch {
    // 记不上就算了
  }
}

// ---------- 插件桥播报（DSH 等外部 agent 让她替自己说一句话，不走 LLM） ----------

export interface PetSayOptions {
  petWindow: BrowserWindow | null
  config: AppConfig
  text: string
  /** 情绪标签名，缺省 neutral；不在 EMOTIONS 里的一律按 neutral */
  emotion?: string
  /** 远程来源（DSH 面板 / agent 桥接）：桌面平板保持胶囊态不弹出 */
  remote?: boolean
}

/** 让她把一段现成的话说出来（事件流与摸头反应一致：思考点 → 情绪 → TTS → 字幕 → 收势）。
 *  视频通话进行中拒绝（busy），摸头反应还在说则切到播报；内容照常写进会话上下文。 */
export async function petSay(options: PetSayOptions): Promise<{ ok: boolean; busy?: boolean; spoken?: boolean }> {
  const text = (options.text ?? '').replace(EMOTION_TAG_RE, '').trim()
  if (!text) return { ok: false }
  if (isTurnActive()) return { ok: false, busy: true }
  cancelPat(toPet(options.petWindow)) // 摸头反应还在说：直接切到播报

  const emotion = (EMOTIONS as readonly string[]).includes(options.emotion ?? '')
    ? (options.emotion as string)
    : 'neutral'
  const send = toPet(options.petWindow)
  const signal = new AbortController()
  patAbort = signal
  let audioStarted = false
  let revealed = false
  const reveal = (): void => {
    if (revealed) return
    revealed = true
    send('pet:sentence', text)
  }

  try {
    send('pet:state', 'thinking') // 重置字幕缓冲，气泡先出思考点
    send('pet:emotion', emotion)
    if (isTtsReady(options.config.tts)) {
      send('pet:tts-preload')
      try {
        await synthesizePcm(options.config.tts, text, {
          signal: signal.signal,
          onChunk: (pcm) => {
            if (!audioStarted) {
              audioStarted = true
              send('pet:tts-start')
              reveal()
            }
            send('pet:tts-chunk', pcm.toString('base64'))
          }
        })
      } catch (error) {
        if ((error as TTSError).message === '已取消') return { ok: true, spoken: false }
        console.error('[tts]', error)
        reveal()
        send('pet:tts-error', (error as Error).message)
      }
    }
    if (!audioStarted) {
      send('pet:tts-start')
      reveal()
      // 没出声（未配语音/合成失败）：按朗读时长撑一下播报动画
      const holdMs = Math.min(30_000, Math.max(1_600, text.length * 270))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, holdMs)
        signal.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }
    persistExchange('（编程助手让你向用户播报这条消息，你照说了）', text, emotion)
    return { ok: true, spoken: true }
  } finally {
    const cancelled = signal.signal.aborted
    patAbort = null
    if (!cancelled) send('pet:tts-end')
  }
}

// ---------- 控制桥聊天（外部 agent 以正常用户消息跑一轮，拿回她的回复文本） ----------

/** 有活动会话就用，没有就新建（与 pet:send 的兜底一致），返回会话 id */
export function ensureActiveSession(): string {
  const existing = getActiveSessionId()
  if (existing && loadSessions().sessions.some((s) => s.id === existing)) return existing
  const store = loadSessions()
  const session = newSession('')
  store.sessions.unshift(session)
  saveSessions(store)
  setActiveSession(session.id)
  return session.id
}

export interface ExternalChatResult {
  /** 她的完整回复文本；被取消/失败没等到回复时为 null */
  reply: string | null
}

/** 外部 agent（控制桥 /chat）以正常用户消息发起一轮对话：她用自己的大脑（智谱 + 语音）回复，
 *  界面照常走对话事件流。回复文本一定稿就 resolve（不等语音播完）；没等到回复就收尾时给 null。
 *  一律带 remote 标记：她在远程面板里说话，桌面平板保持胶囊态不弹出。 */
export function chatExternal(petWindow: BrowserWindow | null, config: AppConfig, text: string): Promise<ExternalChatResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (reply: string | null): void => {
      if (settled) return
      settled = true
      resolve({ reply })
    }
    void runTurn({
      petWindow,
      config,
      sessionId: ensureActiveSession(),
      text,
      remote: true,
      onAssistant: (reply) => finish(reply),
      onEnd: () => finish(null) // 兜底：失败/被打断也要 resolve，别把调用方吊死
    })
  })
}

// ---------- 档案记忆提取（后台，不影响对话） ----------

/** 每会话的提取防抖：连聊时只排最后一个定时器，静默 20 秒后才真正调一次提取 */
const profileTimers = new Map<string, ReturnType<typeof setTimeout>>()
let profileBusy = false

function scheduleProfileExtraction(sessionId: string, llm: AppConfig['llm']): void {
  const prev = profileTimers.get(sessionId)
  if (prev) clearTimeout(prev)
  profileTimers.set(
    sessionId,
    setTimeout(() => {
      profileTimers.delete(sessionId)
      void runProfileExtraction(sessionId, llm)
    }, 20_000)
  )
}

async function runProfileExtraction(sessionId: string, llm: AppConfig['llm']): Promise<void> {
  if (profileBusy) return // 忙时直接丢：下一轮对话会再次排期，窗口式提取不丢事实
  // 这场里没有用户发言（比如只有开场白）就不值得提取
  profileBusy = true
  try {
    const session = loadSessions().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const recent = session.messages.slice(-16)
    if (!recent.some((m) => m.role === 'user' && !m.hidden)) return
    const dialogue = dialogueForExtraction(recent)
    if (dialogue.length < 20) return
    await updateProfileFromConversation(llm, dialogue)
  } catch (error) {
    // 记忆是锦上添花：提取失败静默，不影响任何主流程
    console.error('[profile]', error)
  } finally {
    profileBusy = false
  }
}
