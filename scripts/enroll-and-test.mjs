// 一次性执行：注册克隆音色 → 合并写入应用配置 → 试听验证
// 用法：先把参考音频放到 assets/voice/reference.mp3，再 node scripts/enroll-and-test.mjs
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const key = execSync("powershell -Command [Environment]::GetEnvironmentVariable('DASHSCOPE_API_KEY','User')", { encoding: 'utf8' }).trim().replace(/\r/g, '')
if (!key) { console.log('未找到 DASHSCOPE_API_KEY'); process.exit(1) }
console.log('Key 长度:', key.length)

const BASE = 'https://dashscope.aliyuncs.com'
const headers = { Authorization: 'Bearer ' + key }
const MODEL = 'qwen-audio-3.1-tts-flash'

// ── 第一步：申请临时上传凭证 ──
console.log('\n[1/4] 申请上传凭证…')
const policyRes = await fetch(`${BASE}/api/v1/uploads?action=getPolicy&model=voice-enrollment`, { headers })
const policyBody = await policyRes.json()
const policy = policyBody.data
if (!policyRes.ok || !policy?.upload_host) {
  console.log('FAIL 获取凭证失败:', JSON.stringify(policyBody).slice(0, 300))
  process.exit(1)
}
console.log('  凭证 OK，OSS:', policy.upload_host)

// ── 第二步：上传参考音频 ──
const refPath = join(root, 'assets', 'voice', 'reference.mp3')
if (!existsSync(refPath)) {
  console.log('FAIL 找不到参考音频：', refPath)
  console.log('     请把你自己的参考音频（单人清晰人声，建议 10 秒以上）放到上面这个路径，文件名保持 reference.mp3')
  process.exit(1)
}
console.log('[2/4] 上传参考音频 reference.mp3…')
const audio = readFileSync(refPath)
if (audio.length < 100 * 1024) {
  console.log(`FAIL 参考音频只有 ${(audio.length / 1024).toFixed(0)} KB，太小，多半不是有效录音`)
  process.exit(1)
}
const ext = 'mp3'
const objectKey = `${policy.upload_dir}/${randomUUID().replace(/-/g, '')}.${ext}`
const form = new FormData()
form.append('OSSAccessKeyId', policy.oss_access_key_id)
form.append('Signature', policy.signature)
form.append('policy', policy.policy)
form.append('x-oss-object-acl', 'private')
form.append('x-oss-forbid-overwrite', 'true')
form.append('key', objectKey)
form.append('success_action_status', '200')
form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), `reference.${ext}`)
const upRes = await fetch(policy.upload_host, { method: 'POST', body: form })
if (!upRes.ok) {
  console.log('FAIL 上传失败 HTTP', upRes.status)
  process.exit(1)
}
console.log('  上传 OK')

// ── 第三步：创建克隆音色 ──
console.log('[3/4] 创建克隆音色（target_model:', MODEL, ')…')
const enrollRes = await fetch(`${BASE}/api/v1/services/audio/tts/customization`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json', 'X-DashScope-OssResourceResolve': 'enable' },
  body: JSON.stringify({
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: MODEL,
      prefix: 'deskpet',
      url: `oss://${objectKey}`,
      language_hints: ['zh']
    }
  })
})
const enrollBody = await enrollRes.json()
const voiceId = enrollBody.output?.voice_id ?? enrollBody.output?.voiceId
if (!enrollRes.ok || !voiceId) {
  console.log('FAIL 音色注册失败:', JSON.stringify(enrollBody).slice(0, 400))
  process.exit(1)
}
console.log('  音色注册成功 voice_id =', voiceId)

// ── 第四步：实时合成试听 ──
console.log('[4/4] WebSocket 实时合成试听…')
const text = '接通啦。我就在你的桌面上，随时都可以找我说话哦。'
const taskId = randomUUID()
const ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference', {
  headers: { Authorization: 'Bearer ' + key }
})
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

const pcmChunks = []
let started = false
let failed = null
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (started) pcmChunks.push(Buffer.from(data))
    return
  }
  const ev = JSON.parse(String(data))
  const h = ev.header ?? {}
  if (h.task_id && h.task_id !== taskId) return
  if (h.event === 'task-started' && !started) {
    started = true
    ws.send(JSON.stringify({
      header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: { text } }
    }))
    ws.send(JSON.stringify({
      header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
      payload: { input: {} }
    }))
  }
  if (h.event === 'task-failed') failed = `${h.error_code}: ${h.error_message}`
})
ws.on('message', () => {})

ws.send(JSON.stringify({
  header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
  payload: {
    task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
    model: MODEL,
    parameters: { text_type: 'PlainText', voice: voiceId, format: 'pcm', sample_rate: 24000, rate: 1 },
    input: {}
  }
}))

const done = new Promise((resolve) => {
  const check = setInterval(() => {
    if (failed || ws.readyState === 3) { clearInterval(check); resolve() }
  }, 200)
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const ev = JSON.parse(String(data))
      if (ev.header?.event === 'task-finished' && ev.header.task_id === taskId) { clearInterval(check); resolve() }
    }
  })
})
await done
ws.close()

if (failed) { console.log('FAIL 合成失败:', failed); process.exit(1) }
const totalPcm = pcmChunks.reduce((n, c) => n + c.length, 0)
console.log(`  合成 OK：${totalPcm} 字节 PCM ≈ ${(totalPcm / 2 / 24000).toFixed(1)} 秒音频`)

// ── 写入应用配置（合并写入：只更新注册结果相关的 tts 字段，保留用户已有配置）──
const dataDir = join(process.env.APPDATA, 'deskpet-tablet', 'data')
mkdirSync(dataDir, { recursive: true })
const configFile = join(dataDir, 'config.json')
let config = {}
try { config = JSON.parse(readFileSync(configFile, 'utf-8')) } catch { /* 首次使用：无配置 */ }
config.tts = { ...(config.tts ?? {}), enabled: true, apiKey: key, model: MODEL, voice: voiceId }
if (!config.llm) {
  config.llm = { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', model: 'glm-5.3-flash' }
}
writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8')
console.log('\n已写入配置（合并模式，其他设置原样保留）:', configFile)

// 存一段试听 WAV 方便人工确认
const pcm = Buffer.concat(pcmChunks)
const wavHeader = Buffer.alloc(44)
wavHeader.write('RIFF', 0); wavHeader.writeUInt32LE(36 + pcm.length, 4); wavHeader.write('WAVE', 8)
wavHeader.write('fmt ', 12); wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20)
wavHeader.writeUInt16LE(1, 22); wavHeader.writeUInt32LE(24000, 24); wavHeader.writeUInt32LE(48000, 28)
wavHeader.writeUInt16LE(2, 32); wavHeader.writeUInt16LE(16, 34); wavHeader.write('data', 36)
wavHeader.writeUInt32LE(pcm.length, 40)
writeFileSync(join(root, 'scripts', '试听.wav'), Buffer.concat([wavHeader, pcm]))
console.log('试听文件:', join(root, 'scripts', '试听.wav'))
