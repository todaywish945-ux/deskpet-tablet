/**
 * 人物动画状态机（视频模式 + 贴纸占位模式）。
 *
 * 视频模式由 assets/animations/manifest.json 声明：
 *   idle / talk 支持 string 或 string[]（待机单曲循环、点击屏幕切换；说话每条回复随机选一种）
 *   settle: 说话片段 → 收势片段的映射。收势片段必须从源视频里"紧接对应说话片段出点"的位置剪出，
 *           说话结束时当前视频自然播完尾巴再链入收势，帧级连续、零跳变
 *   emotions: 情绪名 → 片段，播放一遍后自动回落到说话/待机
 *
 * 循环不做原生 loop：带循环点的片段播到 loopOut 时 seek 回 loopIn（两帧几乎相同，肉眼无缝）；
 * 无循环点的片段在结尾用交叉淡化续接。
 *
 * ⚠ Chromium + 自定义协议媒体管线的两个坑（改动前必读）：
 *   1) 数据未稳定流动时设置 currentTime → 管道进入永不完成的 seek，元素永久冻结；
 *      因此启动时不 seek，循环点跳转只在播放中执行。
 *   2) canplay 事件会多次触发，swap 必须幂等（先摘处理器 + 已激活守卫）。
 */

interface Manifest {
  idle?: string | string[]
  talk?: string | string[]
  settle?: Record<string, string>
  emotions?: Record<string, string>
  /** 说话风格 ↔ 待机之间的帧级过渡片段（enter: 待机→风格，exit: 风格→待机） */
  transitions?: Record<string, { enter: string; exit: string }>
}

interface ReactionData {
  scenes: Record<string, string>
  items: { id: string; file: string; caption: string; persona: string; scenes: string[] }[]
}

export type PetState = 'idle' | 'talk'

/** 情绪片段兜底上限：正常由片段播完（ended）收尾，这个定时器只在片段异常时不让她卡在情绪里 */
const EMOTION_HOLD_MS = 25000
/** 无循环点片段的结尾交叉淡化时长（秒） */
const FADE_S = 0.34

function toArray(value?: string | string[]): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function shuffle<T>(list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export class AnimationPlayer {
  private container: HTMLElement
  /** 素材基址随皮肤：构造时传入（petasset://skin/<皮肤目录>） */
  private readonly base: string
  private manifest: Manifest | null = null
  private emotionMap: Record<string, string> = {}

  private mode: 'loading' | 'video' | 'placeholder' = 'loading'
  private layers: HTMLVideoElement[] = []
  private activeLayer = 0
  private img: HTMLImageElement | null = null

  private state: PetState = 'idle'
  private emotion: string | null = null
  private emotionTimer: ReturnType<typeof setTimeout> | null = null

  private idleList: string[] = []
  private idleIdx = 0
  private settleIdx = 0
  private talkList: string[] = []
  /** 本条回复使用的说话片段：每次从待机进入说话时选定，说完保持不变 */
  private currentTalk: string | null = null
  /** 说话结束时待衔接的收势片段：当前视频自然播完尾巴后链入 */
  private pendingSettle: string | null = null
  /** 正在播放的收势片段 */
  private settling: string | null = null
  private loopPoints: Record<string, { loopIn: number; loopOut: number }> = {}

  /** 当前片段是否需要循环（idle/talk 循环，情绪/收势只播一遍） */
  private loopingClip = false
  /** 每次画面切换自增；异步回调比对 token，过期即放弃，防止旧切换污染新状态 */
  private fadeToken = 0
  private monitorStarted = false
  private failStreak = 0

  /** 说话风格的进出场过渡片段映射 */
  private transitions: Record<string, { enter: string; exit: string }> = {}
  /** 正在播"待机→说话"过渡：结束后链入该说话片段（音频未到则停在过渡尾帧等） */
  private enteringTalk: string | null = null
  /** 正在播"说话→待机"过渡：结束后回待机循环 */
  private exiting = false

  constructor(container: HTMLElement, base = 'petasset://assets') {
    this.container = container
    this.base = base
  }

  async init(): Promise<void> {
    // petasset 响应可能命中 Chromium 磁盘缓存的旧条目，清单类请求全部带时间戳绕开
    const bust = `?v=${Date.now()}`
    const [manifest, reactions, points] = await Promise.all([
      this.tryFetchJson<Manifest>(`${this.base}/animations/manifest.json${bust}`),
      this.tryFetchJson<ReactionData>(`${this.base}/stickers/reactions.json${bust}`),
      this.tryFetchJson<Record<string, { loopIn: number; loopOut: number }>>(
        `${this.base}/animations/loop-points.json${bust}`
      )
    ])
    if (reactions) this.buildEmotionMap(reactions)
    if (points) this.loopPoints = points

    if (manifest && toArray(manifest.idle).length > 0) {
      this.manifest = manifest
      this.idleList = shuffle(toArray(manifest.idle))
      this.talkList = toArray(manifest.talk)
      this.transitions = manifest.transitions ?? {}
      this.settleIdx = 0
      this.mode = 'video'
      this.setupVideoLayers()
    } else {
      this.mode = 'placeholder'
      this.setupPlaceholder()
    }
    this.render(true)
  }

  private async tryFetchJson<T>(url: string): Promise<T | null> {
    try {
      const response = await fetch(url)
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    }
  }

  private buildEmotionMap(data: ReactionData): void {
    for (const scene of Object.keys(data.scenes ?? {})) {
      const item = data.items?.find((entry) => entry.scenes?.includes(scene))
      if (item) this.emotionMap[scene] = item.file
    }
  }

  /** 灵动岛收起前冻结画面：两路视频都暂停（rAF 监控对 paused 片段本来就跳过，不会误判卡死） */
  pauseAll(): void {
    for (const video of this.layers) video.pause()
  }

  /** 平板从岛态唤回后从冻结处续播 */
  resumeAll(): void {
    const current = this.layers[this.activeLayer]
    if (current && current.src) void current.play().catch(() => undefined)
  }

  /** 用户开口/闭口 */
  setTalking(talking: boolean): void {    const wasTalking = this.state === 'talk'
    this.state = talking ? 'talk' : 'idle'
    if (talking) {
      // 新回复打断一切收势与未触发的音频收口
      if (this.finishTimer) {
        clearTimeout(this.finishTimer)
        this.finishTimer = null
      }
      if (this.holdTimer) {
        clearTimeout(this.holdTimer)
        this.holdTimer = null
      }
      this.settling = null
      this.pendingSettle = null
      this.exiting = false
      // 声音一响立即张嘴：先行情绪片段让位（反应已在合成期间播过），不再压住说话画面
      if (this.emotionTimer) {
        clearTimeout(this.emotionTimer)
        this.emotionTimer = null
      }
      this.emotion = null
      // "待机→说话"过渡还在播：不切画面，过渡播完由 onClipFinished 链入说话循环
      if (this.enteringTalk) return
      if (this.talkList.length > 0) {
        // 从待机重新开口：选说话方式。已有情绪指引时按情绪选，否则随机避开上一次用的
        if (this.emotion && this.talkForEmotion(this.emotion)) {
          this.currentTalk = this.talkForEmotion(this.emotion)
        } else if (!this.currentTalk) {
          const prev = this.currentTalk
          const pool = this.talkList.length > 1 ? this.talkList.filter((f) => f !== prev) : this.talkList
          this.currentTalk = pool[Math.floor(Math.random() * pool.length)]
        }
      }
      // 声音刚到、人还在待机：此刻播"待机→说话"过渡（0.7s），播完链入说话循环。
      // 本来就在说话（打断续聊）则不重播过渡
      const style = this.currentTalk
      const tr = style ? this.transitions[style] : null
      if (tr?.enter && !wasTalking) {
        this.enteringTalk = style
        this.showVideo(`${this.base}/animations/${tr.enter}`, { loop: false }, true, 200)
        this.preloadHidden(`${this.base}/animations/${style}`, 300)
        return
      }
    } else if (this.emotion) {
      // 情绪片段还在播：让它播完直接回待机，不播收势（收势只跟说话素材衔接）
      return
    } else if (this.currentTalk && this.manifest?.settle?.[this.currentTalk]) {
      // 说话结束：不切片段，让当前视频自然播完尾巴，ended 后无缝链入紧邻的收势片段
      this.pendingSettle = this.manifest.settle[this.currentTalk]
      this.loopingClip = false
      this.activeLoop = null
      this.preloadSettle(this.pendingSettle)
      return
    }
    // 说话结束时若情绪片段还在播：让它播完由 ended 直接过渡到待机，
    // 避免插进一瞬间的说话画面再切走（看起来像闪一下）
    if (!talking && this.emotion) return
    this.render()
  }

  private finishTimer: ReturnType<typeof setTimeout> | null = null
  /** 过渡尾帧待命计时：等声音太久自动回待机 */
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  /** 合成开始时预载本条回复将用的说话片段：开口切换零等待（声音响起时嘴立即出现） */
  preloadTalk(): void {
    if (this.mode !== 'video' || this.talkList.length === 0) return
    // 已在说话循环/过渡中：新语音直接续用当前画面，不重播过渡
    if (this.state === 'talk' || this.enteringTalk) return
    // 与 setTalking 相同的策略，把风格提前定下来（情绪此时已先行推送）
    if (!this.currentTalk) {
      if (this.emotion && this.talkForEmotion(this.emotion)) {
        this.currentTalk = this.talkForEmotion(this.emotion)
      } else {
        const pool = this.talkList.length > 1 ? this.talkList.filter((f) => f !== this.currentTalk) : this.talkList
        this.currentTalk = pool[Math.floor(Math.random() * pool.length)]
      }
    }
    const style = this.currentTalk
    if (!style) return
    const tr = this.transitions[style]
    // 合成等待期保持待机，只做预载：
    // 有入场过渡 → 预载过渡片（声音到时切过去零等待）；无过渡 → 预载说话片段
    const hidden = this.layers[1 - this.activeLayer]
    const url = `${this.base}/animations/${tr?.enter ?? style}`
    if (hidden.src === url) return
    hidden.loop = false
    hidden.oncanplay = null
    hidden.src = url
    hidden.load()
  }

  /** 延迟把片段预载进当前隐藏层（等层间淡出结束后再写 src，避免闪黑）。
   *  铁律：绝不写可见层——往显示中的 video 写 src 会清空画面露出底色（白闪） */
  private preloadHidden(url: string, delayMs = 900): void {
    setTimeout(() => {
      if (this.mode !== 'video') return
      const hidden = this.layers[1 - this.activeLayer]
      if (this.layers[this.activeLayer] === hidden) return // 目标是可见层：放弃（showVideo 会冷加载兜底）
      if (hidden.src === url) return
      hidden.loop = false
      hidden.oncanplay = null
      hidden.src = url
      hidden.load()
    }, delayMs)
  }

  /**
   * 音频驱动的收口：语音还剩 msUntilAudioEnd 播完。
   * 有出场过渡的风格：倒排时机播"说话→待机"过渡片，语音结束瞬间正好过渡完成落回待机；
   * 无过渡的风格：提前留出过渡时间淡出说话画面。过渡时长夹在 200~600ms。
   */
  finishTalkingAt(msUntilAudioEnd: number): void {
    this.state = 'idle'
    this.pendingSettle = null
    this.settling = null
    const tr = this.currentTalk ? this.transitions[this.currentTalk] : null
    if (tr?.exit) {
      this.loopingClip = false
      this.activeLoop = null
      // 出场片时长从隐藏层元数据读（preloadHidden 已在说话期间载好），读不到按 0.7s 估
      const hidden = this.layers[1 - this.activeLayer]
      const exitUrl = `${this.base}/animations/${tr.exit}`
      const dur =
        hidden.src === exitUrl && isFinite(hidden.duration) && hidden.duration > 0 ? hidden.duration : 0.7
      const delay = Math.min(Math.max(0, msUntilAudioEnd / 1000 - dur), 2.5) // 硬上限：音频时钟漂移时淡出最多延迟 2.5s，不再无限停在尾帧
      if (this.finishTimer) clearTimeout(this.finishTimer)
      this.finishTimer = setTimeout(() => {
        this.finishTimer = null
        this.exiting = true
        this.showVideo(exitUrl, { loop: false }, true, 250)
        // 待机片段预载回另一层：450ms 后写（淡出 250ms 已结束、出场片 650ms 还没播完），
        // 若等到出场片播完再写会命中还在显示尾帧的可见层 → 画面被清空白闪
        const idleFile = this.idleList[this.idleIdx]
        if (idleFile) this.preloadHidden(`${this.base}/animations/${idleFile}`, 450)
        this.currentTalk = null
      }, delay * 1000)
      return
    }
    this.loopingClip = false
    this.activeLoop = null
    const transitionMs = Math.min(600, Math.max(200, msUntilAudioEnd))
    const delay = Math.min(Math.max(0, msUntilAudioEnd - transitionMs), 2500) // 硬上限：收口淡出最多延迟 2.5s
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null
      this.render(true, 450)
    }, delay)
  }

  /** 打断时取消未触发的收口（否则会在新一轮开口后才切走） */
  cancelFinishTimer(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  /** 展示情绪（一段时间后自动回落到说话/待机）。情绪同时决定本条回复的说话风格 */
  setEmotion(name: string): void {
    this.emotion = name
    if (this.emotionTimer) clearTimeout(this.emotionTimer)
    this.emotionTimer = setTimeout(() => {
      this.emotion = null
      this.render()
    }, EMOTION_HOLD_MS)
    // 情绪指引说话风格：反应演完回到说话动画时，风格与情绪一致
    if (this.talkList.length > 0) {
      this.currentTalk = this.talkForEmotion(name) ?? this.currentTalk
    }
    this.render()
  }

  /** 点击屏幕：切换到下一段待机动画并循环它 */
  cycleIdle(): void {
    if (this.mode !== 'video' || this.idleList.length <= 1) return
    this.idleIdx = (this.idleIdx + 1) % this.idleList.length
    this.render(true)
  }

  // ---------- video 模式 ----------

  private setupVideoLayers(): void {
    for (let i = 0; i < 2; i++) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.style.opacity = '0'
      video.addEventListener('ended', () => {
        // 只有非循环片段（情绪/收势/说话尾巴）会真正播到头
        if (video === this.layers[this.activeLayer]) this.onClipFinished(video)
      })
      video.addEventListener('error', () => {
        // 单个片段缺失：跳到下一段待机（或结束情绪）；整轮全缺则放弃（壁纸仍在）
        if (video === this.layers[this.activeLayer]) {
          this.failStreak++
          if (!this.emotion && this.idleList.length > 0) {
            this.idleIdx = (this.idleIdx + 1) % this.idleList.length
          }
          this.onClipFinished(video)
        }
      })
      this.container.appendChild(video)
      this.layers.push(video)
    }
    this.startMonitor()
  }

  /** 一段不循环的片段播完后的回落/链入 */
  private onClipFinished(endedVideo?: HTMLVideoElement): void {
    // "待机→说话"过渡播完：声音已到（state=talk）→ 链入说话循环；
    // 声音未到（合成中）→ 停在过渡尾帧待命，12 秒后仍未开口则自行回待机
    // （合成被慢机器/显存抢占拖长时不至于僵在半路姿势里）
    if (this.enteringTalk && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      const talk = this.enteringTalk
      this.enteringTalk = null
      if (this.state === 'talk') {
        this.showVideo(`${this.base}/animations/${talk}`, { loop: true }, true, 120)
        // 说话占住一层后，把出场过渡预载进空闲层，收口时零等待
        const tr = this.transitions[talk]
        if (tr?.exit) this.preloadHidden(`${this.base}/animations/${tr.exit}`)
      } else {
        if (this.holdTimer) clearTimeout(this.holdTimer)
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          // 期间声音到了（state=talk）就不动；否则放弃这次开口，回待机
          if (this.state !== 'talk' && !this.enteringTalk) {
            this.currentTalk = null
            this.render()
          }
        }, 12_000)
      }
      // 声音未到：保持尾帧，等 setTalking(true) 的 render 链入
      return
    }
    // "说话→待机"过渡播完：回到待机循环（idle 片段已由 preloadHidden 预载回隐藏层）
    if (this.exiting && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      this.exiting = false
      this.render()
      return
    }
    // 说话片段尾巴播完：无缝链入紧邻的收势片段（收势首帧=尾巴末帧的下一帧）
    if (!this.settling && this.pendingSettle && endedVideo && endedVideo === this.layers[this.activeLayer]) {
      const file = this.pendingSettle
      this.pendingSettle = null
      this.settling = file
      this.showVideo(`${this.base}/animations/${file}`, { loop: false }, true)
      return
    }
    // 收势片段播完（或异常缺失）→ 回待机
    if (this.settling) {
      this.settling = null
    }
    if (this.emotion) {
      if (this.emotionTimer) clearTimeout(this.emotionTimer)
      this.emotionTimer = null
      this.emotion = null
    }
    this.render()
  }

  private startMonitor(): void {
    if (this.monitorStarted) return
    this.monitorStarted = true
    const tick = (): void => {
      if (this.mode === 'video') {
        this.checkLoopPoints()
        this.checkLoopFade()
        this.checkStuck()
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private lastTime = 0
  private stuckTicks = 0

  /** 自愈：元素在播放状态但时钟停走（隐藏窗口启动被 Chromium 冻结的管道）时强制重载 */
  private checkStuck(): void {
    const cur = this.layers[this.activeLayer]
    if (!cur.src || cur.paused) {
      this.stuckTicks = 0
      return
    }
    if (Math.abs(cur.currentTime - this.lastTime) > 0.001) {
      this.lastTime = cur.currentTime
      this.stuckTicks = 0
      return
    }
    this.stuckTicks++
    if (this.stuckTicks > 90) {
      this.stuckTicks = 0
      this.settleIdx = 0
      // 冻结的元素无法恢复，整层重建
      const old = this.layers
      this.layers = []
      this.activeLayer = 0
      this.fadeToken++
      this.loopingClip = false
      for (const v of old) {
        try {
          v.pause()
        } catch {
          /* 忽略 */
        }
        v.removeAttribute('src')
        v.load()
        v.remove()
      }
      this.setupVideoLayers()
      this.render(true)
    }
  }

  /** 首尾最佳匹配帧循环（loop-points.json）：到达 loopOut 直接跳回 loopIn，两帧几乎相同、肉眼无缝。
   *  只在播放中跳；跳回的是已缓冲过的开头（loopIn），即使缓冲余量紧（rs<4）也安全。 */
  private checkLoopPoints(): void {
    if (!this.loopingClip || !this.activeLoop) return
    const cur = this.layers[this.activeLayer]
    if (!cur.src || cur.paused || cur.ended) return
    if (cur.readyState < 2) return
    if (cur.currentTime >= this.activeLoop.loopOut) {
      cur.currentTime = this.activeLoop.loopIn
    }
  }

  /** 循环片段播到只剩 FADE_S 秒时，用另一层从第 0 帧淡入，掩盖接缝 */
  private checkLoopFade(): void {
    if (!this.loopingClip || this.activeLoop) return
    const cur = this.layers[this.activeLayer]
    // 原生 loop 的整周期片段不会到结尾，也无需淡化掩盖接缝
    if (!cur.src || cur.paused || cur.ended || cur.loop) return
    const duration = cur.duration
    if (!isFinite(duration) || duration <= 0.6) return
    if (duration - cur.currentTime > FADE_S) return

    const token = ++this.fadeToken
    this.loopingClip = false // 淡化期间不重复触发
    const next = this.layers[1 - this.activeLayer]

    const swap = (): void => {
      next.oncanplay = null
      if (token !== this.fadeToken) return
      void next
        .play()
        .then(() => {
          if (token !== this.fadeToken) return
          next.style.opacity = '1'
          cur.style.opacity = '0'
          this.activeLayer = 1 - this.activeLayer
          this.loopingClip = true
          setTimeout(() => {
            if (token === this.fadeToken && this.layers[this.activeLayer] !== cur) cur.pause()
          }, 750)
        })
        .catch(() => undefined)
    }
    if (next.src === cur.src && next.readyState >= 3) {
      swap()
    } else {
      next.src = cur.src
      next.oncanplay = swap
      next.load()
    }
  }

  // ---------- placeholder 模式 ----------

  private static IDLE_STICKER = '22-red-daily-listening.png'
  private static TALK_STICKER = '23-red-daily-yes.png'

  private setupPlaceholder(): void {
    const img = document.createElement('img')
    img.className = 'char'
    img.draggable = false
    this.container.appendChild(img)
    this.img = img
  }

  // ---------- 目标片段解析与渲染 ----------

  private currentEmotionClip(): string | null {
    if (!this.emotion) return null
    return this.manifest?.emotions?.[this.emotion] ?? null
  }

  private currentIdleClip(): string | null {
    if (this.idleList.length === 0) return null
    return `${this.base}/animations/${this.idleList[this.idleIdx % this.idleList.length]}`
  }

  private activeLoop: { loopIn: number; loopOut: number } | null = null

  /** 情绪 → 说话风格：积极热闹用 talk_02（明亮带笑），低落安静用 talk_03（柔和慵懒） */
  /** 情绪 → 说话风格。风格不在当前池内时返回 null（回退随机/默认） */
  private talkForEmotion(emotion: string): string | null {
    const pick = (file: string): string | null => (this.talkList.includes(file) ? file : null)
    // 握拳：打气/开心/元气类
    if (['celebrate', 'encourage', 'playful', 'thanks', 'welcome', 'morning', 'agree'].includes(emotion)) {
      return pick('talk_04_loop.mp4')
    }
    // 捂脸：害羞/道歉
    if (['shy', 'apology'].includes(emotion)) {
      return pick('talk_face.mp4')
    }
    // 眯眼微笑：温柔/暖心类
    if (['affection', 'moved', 'comfort', 'care', 'reassure', 'patience'].includes(emotion)) {
      return pick('talk_squint.mp4')
    }
    // 待机说话：平静/中性/低落类
    if (['neutral', 'listen', 'thinking', 'curious', 'sad', 'sleepy', 'night', 'tired', 'rest'].includes(emotion)) {
      return pick('talk_standby.mp4')
    }
    return pick('talk_standby.mp4')
  }

  private render(force = false, fadeMs?: number): void {
    if (this.mode === 'loading') return
    // 说话尾巴待播收势：冻结当前选择，让视频自然播完（ended 会链入收势）
    if (this.pendingSettle) return

    if (this.mode === 'placeholder') {
      const emotionFile = this.emotion ? this.emotionMap[this.emotion] : null
      const file =
        emotionFile ?? (this.state === 'talk' ? AnimationPlayer.TALK_STICKER : AnimationPlayer.IDLE_STICKER)
      this.showSticker(`${this.base}/stickers/${file}`, emotionFile != null, force)
      return
    }

    const emotionClip = this.currentEmotionClip()
    if (emotionClip) {
      // 情绪片段：播一遍，播完由 ended 事件回落
      this.showVideo(`${this.base}/animations/${emotionClip}`, { loop: false }, force, fadeMs)
      return
    }
    if (this.settling) {
      this.showVideo(`${this.base}/animations/${this.settling}`, { loop: false }, force, fadeMs)
      return
    }
    if (this.state === 'talk' && this.currentTalk) {
      // 开口快切：声音已响起，过渡压到 150ms 让嘴立即跟上
      this.showVideo(`${this.base}/animations/${this.currentTalk}`, { loop: true }, force, fadeMs ?? 150)
      return
    }
    // 说话结束回到待机时清掉本条回复的说话片段选择
    if (this.state === 'idle' && this.currentTalk) this.currentTalk = null
    // 待机：当前选中的片段循环，点击屏幕可切换
    if (this.failStreak >= this.idleList.length) return
    const idle = this.currentIdleClip()
    if (idle) this.showVideo(idle, { loop: true }, force, fadeMs)
  }

  private showVideo(src: string, opts: { loop: boolean }, force: boolean, fadeMs?: number): void {
    const current = this.layers[this.activeLayer]
    // 有循环点的片段走 seek 跳转（loopIn 非 0），首尾帧已对齐的整周期片段用原生 loop 完全无缝
    const nativeLoop = opts.loop && !this.loopPoints[src.split('/').pop() ?? '']
    if (!force && current.src === src && !current.paused && !current.ended) {
      // 同一片段继续：恢复循环状态（例如打断收势后回到说话尾巴）
      this.loopingClip = opts.loop
      const file = src.split('/').pop() ?? ''
      this.activeLoop = opts.loop && !nativeLoop ? (this.loopPoints[file] ?? null) : null
      current.loop = nativeLoop
      return
    }

    const token = ++this.fadeToken
    this.loopingClip = opts.loop
    const fileName = src.split('/').pop() ?? ''
    this.activeLoop = opts.loop && !nativeLoop ? (this.loopPoints[fileName] ?? null) : null
    const next = this.layers[1 - this.activeLayer]
    next.loop = nativeLoop
    next.oncanplay = null

    const swap = (): void => {
      // canplay 可能多次触发（seek 后 readyState 回落再上升），摘掉处理器保证 swap 只跑一次
      next.oncanplay = null
      if (token !== this.fadeToken) return
      if (fadeMs !== undefined) {
        next.style.transitionDuration = `${fadeMs}ms`
        current.style.transitionDuration = `${fadeMs}ms`
      } else {
        next.style.transitionDuration = ''
        current.style.transitionDuration = ''
      }
      // 不做任何启动 seek：数据未稳定流动时 seek 会让媒体管道进入永不完成的 seek（冻结）。
      // 带循环点的片段从 0 播起（开头是相近的静止姿态），由 checkLoopPoints 在播放中跳转。
      void next
        .play()
        .then(() => {
          if (token !== this.fadeToken) return
          if (this.layers[this.activeLayer] === next) return
          next.style.opacity = '1'
          current.style.opacity = '0'
          this.activeLayer = 1 - this.activeLayer
          setTimeout(() => {
            if (token === this.fadeToken && this.layers[this.activeLayer] !== current) current.pause()
          }, 750)
          if (this.state === 'idle' && !this.emotion && !this.settling && !this.pendingSettle) {
            this.scheduleTalkPreload()
          }
          // 说话动画上屏后，把出场过渡预载进空闲层（收口零等待）
          if (this.state === 'talk' && this.currentTalk) {
            const tr = this.transitions[this.currentTalk]
            if (tr?.exit) this.preloadHidden(`${this.base}/animations/${tr.exit}`)
          }
        })
        .catch(() => undefined)
    }
    if (next.src === src && next.readyState >= 3) {
      swap()
    } else {
      next.src = src
      next.oncanplay = swap
      next.load()
    }
  }

  private preloadTimer: ReturnType<typeof setTimeout> | null = null

  /** 待机时把说话片段预载进空闲层，开口切换零等待（否则高清片段加载慢，短回复来不及展示） */
  private scheduleTalkPreload(): void {
    if (this.preloadTimer) clearTimeout(this.preloadTimer)
    if (this.talkList.length === 0) return
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null
      if (this.mode !== 'video' || this.state !== 'idle' || this.emotion) return
      const hidden = this.layers[1 - this.activeLayer]
      const url = `${this.base}/animations/${this.talkList[0]}`
      if (hidden.src === url || hidden.readyState >= 3) return
      hidden.loop = false
      hidden.oncanplay = null
      hidden.src = url
      hidden.load()
    }, 700)
  }

  /** 说话结束瞬间把收势片段预载进空闲层：说话尾巴播完时无缝链入 */
  private preloadSettle(file: string): void {
    const hidden = this.layers[1 - this.activeLayer]
    const url = `${this.base}/animations/${file}`
    if (hidden.src === url) return
    hidden.loop = false
    hidden.oncanplay = null
    hidden.src = url
    hidden.load()
  }

  private showSticker(src: string, isEmotion: boolean, force: boolean): void {
    const img = this.img
    if (!img) return
    const cls = isEmotion ? 'pop-in' : this.state === 'talk' ? 'talk-bob' : 'breathe'
    if (!force && img.src === src && img.className.includes(cls)) return
    if (img.src !== src) img.src = src
    img.className = `char ${cls}`
  }
}
