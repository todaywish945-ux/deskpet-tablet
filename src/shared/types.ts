/** 共享类型：主进程与渲染进程共用 */

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export type TTSProvider = 'bailian' | 'gptsovits'

export interface TTSConfig {
  enabled: boolean
  /** 语音引擎：阿里云百炼克隆音色 / 本地 GPT-SoVITS（免费） */
  provider: TTSProvider
  apiKey: string
  /** 百炼合成模型，音色注册时的 target_model 必须与此一致 */
  model: string
  /** 克隆音色 ID（注册后由百炼返回） */
  voice: string
  /** 语速 0.5–2.0 */
  speed: number
  /** 播放音量 0–1 */
  volume: number
  /** GPT-SoVITS api_v2 服务地址 */
  gsvApiBase: string
  /** 参考音频绝对路径（3~10 秒清晰人声） */
  gsvRefAudio: string
  /** 参考音频的文本内容 */
  gsvRefText: string
  /** 参考音频语言 */
  gsvPromptLang: string
  /** 合成文本语言 */
  gsvTextLang: string
  /** 本地语音服务启动脚本（不填用整合包默认路径） */
  gsvLauncherPath?: string
}

/** 她主动开口（闲置关心 / 早安晚安 / 周回顾） */
export interface ProactiveConfig {
  enabled: boolean
}

export interface AppFlagsConfig {
  /** 开机自启（仅打包版生效，dev 下只记录设置） */
  autoStart: boolean
}

export interface CallConfig {
  /** 通话中她说话时检测到你开口就自动停下沉听（barge-in） */
  bargeIn: boolean
}

/** 平板窗口层级：bottom=沉底（藏在所有应用窗口之下，点击平板浮上来）；top=置顶（悬浮在所有应用之上） */
export type PetLayerMode = 'bottom' | 'top'

export interface WindowConfig {
  layer: PetLayerMode
  /** 灵动岛：闲置（失焦）后收成屏幕顶部的胶囊条 */
  island: boolean
  /** 失焦多少秒后收成灵动岛 */
  islandIdleSeconds: number
}

/** 角色皮肤：skins/ 目录下的一个资源包（video 视频切片 / live2d 实时模型） */
export interface CharacterConfig {
  skin: string
}

/** skin.json 契约：渲染层按 backend 选渲染器，字段为包内相对路径 */
export interface SkinMeta {
  id: string
  name: string
  backend: 'video' | 'live2d'
  model?: string
  manifest?: string
  loopPoints?: string
  reactions?: string
  avatar: string
  wallpaper?: string
  tray?: string
  persona: string
  /** 情绪 → 表达（live2d=表情名）或动画文件（video 后端走 manifest，此字段可空） */
  emotions?: Record<string, string>
}

export interface AppConfig {
  llm: LLMConfig
  tts: TTSConfig
  window: WindowConfig
  character: CharacterConfig
  proactive: ProactiveConfig
  app: AppFlagsConfig
  call: CallConfig
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** assistant 消息解析出的情绪（仅展示层使用） */
  emotion?: string
  ts: number
  /** 隐藏消息：写进上下文（如通话主题开场指令），但不在任何界面展示 */
  hidden?: boolean
}

export interface ChatHistory {
  messages: ChatMessage[]
}

/** 一次视频通话 = 一个会话 */
export interface ChatSession {
  id: string
  title: string
  /** 主界面上定的本次主题（可为空） */
  topic: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface SessionStore {
  sessions: ChatSession[]
}

/** 一条关于用户的长期记忆事实（档案记忆） */
export interface ProfileFact {
  id: string
  /** 事实内容，一句话，第三人称视角（如「用户最近在准备期末考试」） */
  text: string
  /** 首次记下的时间 */
  createdAt: number
  /** 最近一次被确认/更新的时间 */
  updatedAt: number
}

/** 用户档案：跨会话共享的长期记忆，每场通话结束后增量更新 */
export interface UserProfile {
  facts: ProfileFact[]
}

export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-5.3-flash'
  },
  tts: {
    enabled: true,
    provider: 'bailian',
    apiKey: '',
    model: 'qwen-audio-3.1-tts-flash',
    voice: '',
    speed: 1.0,
    volume: 1.0,
    gsvApiBase: 'http://127.0.0.1:9880',
    gsvRefAudio: '',
    gsvRefText: '',
    gsvPromptLang: 'zh',
    gsvTextLang: 'zh'
  },
  window: {
    layer: 'bottom',
    island: true,
    islandIdleSeconds: 10
  },
  character: {
    skin: 'yeshunguang'
  },
  proactive: {
    enabled: true
  },
  app: {
    autoStart: false
  },
  call: {
    bargeIn: true
  }
}

/** 情绪标签协议允许的情绪集合 */
export const EMOTIONS = [
  'neutral',
  'listen',
  'comfort',
  'encourage',
  'celebrate',
  'thanks',
  'affection',
  'shy',
  'moved',
  'playful',
  'morning',
  'night',
  'welcome',
  'apology',
  'thinking',
  'curious',
  'sleepy',
  'sad',
  'agree',
  'care',
  'rest',
  'tired',
  'patience',
  'reassure'
] as const

export type Emotion = (typeof EMOTIONS)[number]

// 情绪标签：标准 [emotion:xxx]，模型偶尔偷懒写成 [xxx]——两种都认（剥离时校验名字合法）
/** 情绪标签：全角/半角冒号都认（模型偶尔输出 [emotion：curious]，不匹配会原样漏进气泡） */
export const EMOTION_TAG_RE = /\[emotion[：:]([a-z_]+)\]/g
