import { app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { AppConfig, ChatMessage, ChatHistory, ChatSession, SessionStore, DEFAULT_CONFIG, SkinMeta } from '../../shared/types'

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

/** 单个会话的消息上限，避免老会话无限膨胀 */
const MAX_SESSION_MESSAGES = 200

function sessionsFile(): string {
  return join(dataDir(), 'sessions.json')
}

export function newSession(topic: string): ChatSession {
  const now = Date.now()
  return {
    id: randomUUID(),
    title: topic ? truncate(topic, 18) : '',
    topic,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

export function loadSessions(): SessionStore {
  // 优先读新格式 sessions.json
  try {
    const raw = JSON.parse(readFileSync(sessionsFile(), 'utf-8')) as SessionStore
    if (Array.isArray(raw?.sessions)) return { sessions: raw.sessions }
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
            messages
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

/** 在两个根下找皮肤目录：userData/skins 优先于打包内置 */
export function activeSkinDir(config?: AppConfig): string {
  const id = (config ?? loadConfig()).character?.skin || 'template'
  const candidates = [join(userSkinsRoot(), id), join(assetRoot(), 'skins', id)]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'skin.json'))) return dir
  }
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
        if (meta.id && meta.backend) out.set(meta.id, meta) // userData 后扫，覆盖同名
      }
    } catch {
      // 根不存在/损坏：跳过
    }
  }
  return [...out.values()]
}
