import { app } from 'electron'
import { randomUUID } from 'crypto'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'path'
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'fs'
import { AppConfig, ChatMessage, ChatHistory, ChatSession, SessionStore, DEFAULT_CONFIG, SkinMeta, TTSConfig } from '../../shared/types'

function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function merge<T>(base: T, patch: Partial<T>): T {
  const out = { ...base } as T
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key]
    if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      ;(out as Record<string, unknown>)[key as string] = merge(
        base[key] ?? ({} as T[keyof T]),
        value as Partial<T[keyof T]>
      )
    } else if (value !== undefined) {
      ;(out as Record<string, unknown>)[key as string] = value
    }
  }
  return out
}

export function loadConfig(): AppConfig {
  const file = join(dataDir(), 'config.json')
  let config: AppConfig
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    config = merge(DEFAULT_CONFIG, raw)
  } catch {
    config = structuredClone(DEFAULT_CONFIG)
  }
  // 机器上已有的智谱 Key（如 AI微信聊天项目配置的环境变量）自动兜底
  if (!config.llm.apiKey) {
    const envKey = process.env['ZHIPU_API_KEY']
    if (envKey) config.llm.apiKey = envKey
  }
  return config
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(join(dataDir(), 'config.json'), JSON.stringify(config, null, 2), 'utf-8')
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** 当前激活角色 id（各按角色分家的存储都以它为缺省归属） */
export function activeSkinId(): string {
  return loadConfig().character?.skin || 'yeshunguang'
}

/**
 * 按角色分家的存储文件：档案/回忆/心情等改成每个角色一份（profile-<id>.json 这种形状）。
 * 老的全局单份文件（profile.json）在每个角色首次访问时各复制一份作为起点——
 * 现有记忆双方都保留，之后各自独立增长；原全局文件原样留作备份，不再被读写。
 */
export function characterStoreFile(base: string, skinId?: string): string {
  const id = skinId || activeSkinId()
  const dot = base.lastIndexOf('.')
  const per = `${base.slice(0, dot)}-${id}${base.slice(dot)}`
  const legacy = join(dataDir(), base)
  const file = join(dataDir(), per)
  if (!existsSync(file) && existsSync(legacy)) {
    try {
      copyFileSync(legacy, file)
    } catch {
      // 复制失败按首次使用处理
    }
  }
  return file
}

/** 单个会话的消息上限，避免老会话无限膨胀 */
const MAX_SESSION_MESSAGES = 200

function sessionsFile(): string {
  return join(dataDir(), 'sessions.json')
}

export function newSession(topic: string, characterId?: string): ChatSession {
  const now = Date.now()
  return {
    id: randomUUID(),
    title: topic ? truncate(topic, 18) : '',
    topic,
    createdAt: now,
    updatedAt: now,
    messages: [],
    characterId: characterId || (loadConfig().character?.skin || 'yeshunguang')
  }
}

/** 会话归属回填：旧数据没有 characterId，一次性归到当前皮肤并写回 */
function backfillCharacterId(store: SessionStore): SessionStore {
  if (!store.sessions.some((session) => !session.characterId)) return store
  const fallback = loadConfig().character?.skin || 'yeshunguang'
  for (const session of store.sessions) {
    if (!session.characterId) session.characterId = fallback
  }
  saveSessions(store)
  return store
}

export function loadSessions(): SessionStore {
  // 优先读新格式 sessions.json
  try {
    const raw = JSON.parse(readFileSync(sessionsFile(), 'utf-8')) as SessionStore
    if (Array.isArray(raw?.sessions)) return backfillCharacterId({ sessions: raw.sessions })
  } catch {
    // 首次使用或文件损坏，走迁移
  }
  // 旧版 history.json（单一平铺消息流）整体迁成一个会话
  try {
    const legacy = JSON.parse(readFileSync(join(dataDir(), 'history.json'), 'utf-8')) as ChatHistory
    const messages: ChatMessage[] = Array.isArray(legacy?.messages) ? legacy.messages : []
    if (messages.length > 0) {
      const firstUser = messages.find((m) => m.role === 'user' && !m.hidden)
      const store: SessionStore = {
        sessions: [
          {
            id: randomUUID(),
            title: firstUser ? truncate(firstUser.content, 18) : '此前的对话',
            topic: '',
            createdAt: messages[0]?.ts ?? Date.now(),
            updatedAt: messages[messages.length - 1]?.ts ?? Date.now(),
            messages,
            characterId: loadConfig().character?.skin || 'yeshunguang'
          }
        ]
      }
      saveSessions(store)
      return store
    }
  } catch {
    // 没有旧文件
  }
  return { sessions: [] }
}

export function saveSessions(store: SessionStore): void {
  for (const session of store.sessions) {
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages = session.messages.slice(-MAX_SESSION_MESSAGES)
    }
  }
  writeFileSync(sessionsFile(), JSON.stringify(store, null, 2), 'utf-8')
}

/** 素材目录：开发时是项目根/assets，打包后在 resources/assets */
export function assetRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'assets') : join(app.getAppPath(), 'assets')
}

/** 用户自装皮肤目录（userData/skins） */
export function userSkinsRoot(): string {
  return join(app.getPath('userData'), 'skins')
}

export function findSkinDir(id: string): string | null {
  if (!id || /[\\/:*?"<>|\x00-\x1f]|[. ]$/.test(id)) return null
  const candidates = [join(userSkinsRoot(), id), join(assetRoot(), 'skins', id)]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'skin.json'))) return dir
  }
  return null
}

/** 在两个根下找皮肤目录：userData/skins 优先于打包内置 */
export function activeSkinDir(config?: AppConfig): string {
  const id = (config ?? loadConfig()).character?.skin || 'yeshunguang'
  const selected = findSkinDir(id)
  if (selected) return selected
  // 皮肤缺失（被删/未装）：回退到任一存在的内置皮肤，再不行给 assets 根（旧行为）
  try {
    const bundled = join(assetRoot(), 'skins')
    if (existsSync(bundled)) {
      for (const entry of readdirSync(bundled, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(bundled, entry.name, 'skin.json'))) return join(bundled, entry.name)
      }
    }
  } catch {
    // 扫描失败走旧行为
  }
  return assetRoot()
}

/** 当前皮肤的 skin.json（读不到给 null，调用方兜底默认素材） */
export function activeSkinMeta(config?: AppConfig): SkinMeta | null {
  try {
    return JSON.parse(readFileSync(join(activeSkinDir(config), 'skin.json'), 'utf-8')) as SkinMeta
  } catch {
    return null
  }
}

/** 皮肤内文件的绝对路径（供主进程读头像/图标等二进制） */
export function activeSkinFile(config: AppConfig | undefined, rel: string): string {
  return join(activeSkinDir(config), rel)
}

/** 每轮只解析一次：专属音色仅覆盖运行时快照，不把路径/角色音色写回全局配置。 */
export function resolveTtsConfig(config: AppConfig): TTSConfig {
  const snapshot = { ...config.tts }
  const skinDir = activeSkinDir(config)
  const metaFile = join(skinDir, 'skin.json')
  if (!existsSync(metaFile)) return snapshot // 兼容没有 skin.json 的旧素材目录

  const invalid = (detail: string): Error => new Error(`角色「${config.character.skin}」语音配置无效：${detail}`)
  let meta: SkinMeta
  try {
    meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as SkinMeta
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid skin')
  } catch {
    throw invalid('无法读取 skin.json')
  }
  if (meta.voice === undefined) return snapshot
  const voice = meta.voice
  if (!voice || typeof voice !== 'object' || Array.isArray(voice) || voice.provider !== 'gptsovits') {
    throw invalid('voice.provider 必须是 gptsovits')
  }
  for (const field of ['apiBase', 'refAudio', 'refText', 'inferConfig'] as const) {
    if (typeof voice[field] !== 'string' || !voice[field].trim()) throw invalid(`voice.${field} 不能为空`)
  }
  for (const field of ['promptLang', 'textLang'] as const) {
    if (voice[field] !== undefined && (typeof voice[field] !== 'string' || !voice[field]!.trim())) {
      throw invalid(`voice.${field} 必须是非空语言代码`)
    }
  }

  let api: URL
  try {
    api = new URL(voice.apiBase)
  } catch {
    throw invalid('voice.apiBase 不是有效地址')
  }
  const loopback = api.hostname === 'localhost' || api.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(api.hostname)
  if (api.protocol !== 'http:' || !loopback || api.username || api.password ||
      /[?#@\\\s]/.test(voice.apiBase) || api.pathname !== '/') {
    throw invalid('voice.apiBase 只允许本机 HTTP loopback 地址，不得包含凭证、路径、查询或片段')
  }

  const inside = (root: string, file: string): boolean => {
    const rel = relative(root, file)
    return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  const skinFile = (field: 'refAudio' | 'inferConfig'): string => {
    const rel = voice[field]
    // 同时识别 Windows/POSIX 写法，拒绝盘符相对路径、ADS、上级目录和空路径。
    if (isAbsolute(rel) || win32.isAbsolute(rel) || /[:\0]/.test(rel) || rel.split(/[\\/]/).includes('..')) {
      throw invalid(`voice.${field} 必须是皮肤内相对路径`)
    }
    const full = resolve(skinDir, rel.replace(/\\/g, '/'))
    if (!inside(resolve(skinDir), full)) throw invalid(`voice.${field} 路径越界`)
    if (!existsSync(full) || !statSync(full).isFile()) throw invalid(`voice.${field} 文件不存在：${rel}`)
    // 防止皮肤里的符号链接/目录联接绕过规范化路径校验。
    if (!inside(realpathSync(skinDir), realpathSync(full))) throw invalid(`voice.${field} 链接指向皮肤外`)
    return full
  }

  return {
    ...snapshot,
    provider: 'gptsovits',
    gsvApiBase: api.origin,
    gsvRefAudio: skinFile('refAudio'),
    gsvRefText: voice.refText,
    gsvConfigPath: skinFile('inferConfig'),
    gsvPromptLang: voice.promptLang ?? snapshot.gsvPromptLang,
    gsvTextLang: voice.textLang ?? snapshot.gsvTextLang
  }
}

export function listSkins(): SkinMeta[] {
  const out = new Map<string, SkinMeta>()
  const roots = [join(assetRoot(), 'skins'), userSkinsRoot()]
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const file = join(root, entry.name, 'skin.json')
        if (!existsSync(file)) continue
        const meta = JSON.parse(readFileSync(file, 'utf-8')) as SkinMeta
        if (meta.hidden) continue // 模板空壳等兜底皮肤不作为角色出现
        if (meta.id && meta.backend) out.set(meta.id, meta) // userData 后扫，覆盖同名
      }
    } catch {
      // 根不存在/损坏：跳过
    }
  }
  return [...out.values()]
}
