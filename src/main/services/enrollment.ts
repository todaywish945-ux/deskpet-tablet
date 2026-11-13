import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TTSConfig } from '../../shared/types'
import { TTSError } from './tts'

const BASE = 'https://dashscope.aliyuncs.com'

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra }
}

/** 第一步：向百炼申请一个私有的临时 OSS 上传凭证 */
async function getUploadPolicy(apiKey: string): Promise<Record<string, string>> {
  const response = await fetch(`${BASE}/api/v1/uploads?action=getPolicy&model=voice-enrollment`, {
    headers: headers(apiKey)
  })
  const body = (await response.json()) as { data?: Record<string, string> }
  const policy = body.data
  if (!response.ok || !policy?.upload_host || !policy.upload_dir || !policy.policy) {
    throw new TTSError('百炼没有返回有效的上传凭证，请检查 API Key。')
  }
  return policy
}

/** 第二步：把参考音频上传到该临时 OSS 空间，返回 oss:// 地址 */
async function uploadReference(policy: Record<string, string>, data: Buffer): Promise<string> {
  const extension = 'mp3'
  const mime = 'audio/mpeg'
  const key = `${policy.upload_dir}/${randomUUID().replace(/-/g, '')}.${extension}`
  const form = new FormData()
  form.append('OSSAccessKeyId', policy.oss_access_key_id)
  form.append('Signature', policy.signature)
  form.append('policy', policy.policy)
  form.append('x-oss-object-acl', 'private')
  form.append('x-oss-forbid-overwrite', 'true')
  form.append('key', key)
  form.append('success_action_status', '200')
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), `reference.${extension}`)

  const response = await fetch(policy.upload_host, { method: 'POST', body: form })
  if (!response.ok) {
    throw new TTSError(`参考音频上传失败（HTTP ${response.status}），音色尚未创建。`)
  }
  return `oss://${key}`
}

export interface EnrollResult {
  voiceId: string
}

/**
 * 注册克隆音色（一次性）：上传 assets/voice/reference.mp3 → create_voice。
 * target_model 必须与之后合成用的模型一致。
 */
export async function enrollVoice(config: TTSConfig, assetRoot: string, namePrefix = 'deskpet'): Promise<EnrollResult> {
  if (!config.apiKey) throw new TTSError('请先填写百炼 API Key。')
  if (!config.model) throw new TTSError('请先选择语音模型。')

  const reference = readFileSync(join(assetRoot, 'voice', 'reference.mp3'))
  const policy = await getUploadPolicy(config.apiKey)
  const ossUrl = await uploadReference(policy, reference)

  const response = await fetch(`${BASE}/api/v1/services/audio/tts/customization`, {
    method: 'POST',
    headers: headers(config.apiKey, {
      'Content-Type': 'application/json',
      'X-DashScope-OssResourceResolve': 'enable'
    }),
    body: JSON.stringify({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: config.model,
        prefix: namePrefix,
        url: ossUrl,
        language_hints: ['zh']
      }
    })
  })
  const body = (await response.json().catch(() => ({}))) as {
    output?: { voice_id?: string; voiceId?: string }
    code?: string
    message?: string
  }
  const voiceId = body.output?.voice_id ?? body.output?.voiceId
  if (!response.ok || !voiceId) {
    throw new TTSError(`音色注册失败：${body.code ?? response.status} ${body.message ?? ''}`.trim())
  }
  return { voiceId }
}
