import { randomUUID } from 'crypto'
import { join } from 'path'
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { UserProfile, ProfileFact } from '../../shared/types'
import { streamChat } from './llm'
import { LLMConfig } from '../../shared/types'

/**
 * 档案记忆：跨会话的用户画像。每场通话结束后用一次 LLM 调用增量更新，
 * 之后每轮对话把档案注入系统提示——她记得你这个人。
 * 档案是唯一权威数据源（profile.json），UI 可查看/删除单条。
 * 被容量挤出或判定过时的事实不删除，转入全量档（profile-full.jsonl，append-only 只存档）。
 */

const MAX_FACTS = 60

function profileFile(): string {
  return join(app.getPath('userData'), 'data', 'profile.json')
}

function profileFullFile(): string {
  return join(app.getPath('userData'), 'data', 'profile-full.jsonl')
}

/** 全量档：append-only 存档被挤出/过时的事实，不注入提示词 */
function appendProfileFull(entries: ProfileFact[], reason: 'overflow' | 'obsolete'): void {
  if (entries.length === 0) return
  const lines = entries.map((f) => JSON.stringify({ ...f, reason })).join('\n')
  appendFileSync(profileFullFile(), lines + '\n', 'utf-8')
}

export function loadProfile(): UserProfile {
  try {
    const raw = JSON.parse(readFileSync(profileFile(), 'utf-8')) as UserProfile
    if (Array.isArray(raw?.facts)) return { facts: raw.facts }
  } catch {
    // 首次使用
  }
  return { facts: [] }
}

export function saveProfile(profile: UserProfile): void {
  writeFileSync(profileFile(), JSON.stringify(profile, null, 2), 'utf-8')
}

export function deleteFact(factId: string): UserProfile {
  const profile = loadProfile()
  profile.facts = profile.facts.filter((f) => f.id !== factId)
  saveProfile(profile)
  return profile
}

/** 档案注入系统提示的段落（空档案返回空串） */
export function profilePrompt(): string {
  const facts = loadProfile().facts
  if (facts.length === 0) return ''
  const lines = facts.map((f) => `- ${f.text}`).join('\n')
  return `\n\n【你长期记得的关于对方的事（跨通话记忆，自然使用，别机械复述）】\n${lines}`
}

const EXTRACT_SYSTEM = `你是一个记忆管理器。任务：根据「已有记忆档案」和「一段刚结束的对话」，更新关于用户「本人」的长期记忆档案。

规则：
1. 只记关于用户本人的、有长期价值的信息：身份/生活状态、喜好厌恶、人际关系、正在经历的事、身心状态、对陪伴方式的偏好、重要的约定。
2. 不记：闲聊寒暄、一次性内容（"帮我讲个故事"）、桌宠说过的话、对话细节。
3. 输出一个 JSON 数组，每个元素：
   {"action":"add","text":"..."} 新增一条（30字内，第三人称，称对方为"用户"）
   {"action":"update","id":"旧条目id","text":"..."} 更新旧条目（信息变化时，text 给最新表述）
   {"action":"remove","id":"..."} 该信息已不再成立
4. 没有任何值得新增/更新的内容就输出 []。
5. 只输出 JSON 数组，不要任何解释或代码块标记。`

interface ExtractAction {
  action: 'add' | 'update' | 'remove'
  id?: string
  text?: string
}

/**
 * 通话结束后台更新档案：把已有档案 + 本场对话交给模型，解析增删改动作。
 * 任何失败都静默返回（记忆是锦上添花，绝不影响主流程）。
 */
export async function updateProfileFromConversation(llm: LLMConfig, dialogue: string): Promise<void> {
  const profile = loadProfile()
  const current =
    profile.facts.length > 0
      ? profile.facts.map((f) => `${f.id}: ${f.text}`).join('\n')
      : '（空）'

  let full = ''
  await streamChat({
    config: llm,
    system: EXTRACT_SYSTEM,
    temperature: 0.2,
    history: [
      {
        role: 'user',
        content: `【已有记忆档案】\n${current}\n\n【刚结束的对话】\n${dialogue}`,
        ts: Date.now()
      }
    ],
    onDelta: (delta) => {
      full += delta
    }
  })

  const actions = parseActions(full)
  if (actions.length === 0) return

  const now = Date.now()
  for (const action of actions) {
    if (action.action === 'add' && action.text) {
      if (profile.facts.some((f) => f.text === action.text!.trim())) continue
      if (profile.facts.length >= MAX_FACTS) {
        const evicted = profile.facts.shift()
        if (evicted) appendProfileFull([evicted], 'overflow')
      }
      const fact: ProfileFact = {
        id: randomUUID().slice(0, 8),
        text: action.text.trim().slice(0, 80),
        createdAt: now,
        updatedAt: now
      }
      profile.facts.push(fact)
    } else if (action.action === 'update' && action.id && action.text) {
      const fact = profile.facts.find((f) => f.id === action.id)
      if (fact) {
        fact.text = action.text.trim().slice(0, 80)
        fact.updatedAt = now
      }
    } else if (action.action === 'remove' && action.id) {
      // 判定「不再成立」的先存进全量档，保留它曾经成立过的历史
      const obsolete = profile.facts.find((f) => f.id === action.id)
      if (obsolete) appendProfileFull([obsolete], 'obsolete')
      profile.facts = profile.facts.filter((f) => f.id !== action.id)
    }
  }
  saveProfile(profile)
}

/** 宽容解析模型输出：截取 JSON 数组段，逐项校验 */
function parseActions(raw: string): ExtractAction[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed)) return []
    const out: ExtractAction[] = []
    for (const item of parsed) {
      const action = (item as ExtractAction)?.action
      if (action === 'add' || action === 'remove') {
        out.push(item as ExtractAction)
      } else if (action === 'update') {
        out.push(item as ExtractAction)
      }
    }
    return out
  } catch {
    return []
  }
}

/** 截取会话文本给提取器用：只留最近的，控制 token */
export function dialogueForExtraction(
  messages: { role: string; content: string }[],
  maxChars = 4000
): string {
  const picked: string[] = []
  let total = 0
  for (const m of [...messages].reverse()) {
    const line = `${m.role === 'user' ? '用户' : '桌宠'}：${m.content}`
    if (total + line.length > maxChars) break
    picked.unshift(line)
    total += line.length
  }
  return picked.join('\n')
}
