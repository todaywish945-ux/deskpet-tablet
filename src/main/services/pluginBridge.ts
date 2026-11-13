import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { join, normalize, sep } from 'path'
import { appendFileSync, existsSync, readFileSync, statSync } from 'fs'
import { WebSocketServer, WebSocket } from 'ws'
import { app, ipcMain } from 'electron'
import { EMOTIONS } from '../../shared/types'
import { getPetWindow } from '../petWindow'
import { assetRoot, activeSkinDir, loadConfig, loadSessions, newSession, saveSessions } from './store'
import { isTtsReady } from './tts'
import { getActiveSessionId, isCallActive, setActiveSession } from './sessionState'
import { noteUserActivity } from './proactive'
import { cancelActiveTurn, cancelPat, chatExternal, isPatActive, isTurnActive, petPat, petSay, runTurn } from './chatPipeline'
import { onPetEvent } from './petEvents'
import { panelHtml } from './panelPage'
import { setDshActivity } from './dshActivity'


/**
 * 本地控制桥：给 DSH（DeepSeek Harness）插件等外部 agent 用的一组本地接口，
 * 只监听 127.0.0.1。插件据此注册工具，让 agent 接通/挂断视频通话、替用户跟她聊、
 * 指挥她说话 / 做表情 / 停止播报；DSH 界面里的内嵌视频面板也吃这套接口。
 *
 * 端口用 PET_PLUGIN_PORT 覆盖（设为 0 关闭整座桥），鉴权用 PET_PLUGIN_TOKEN（可选）。
 * POST 必须带 `x-pet-bridge: 1` 头——浏览器跨域表单发不出这个自定义头，天然挡掉 CSRF。
 *
 * 接口（GET 无需防伪头，POST 均需要）：
 *   GET  /health     → { ok, version, dev, ttsReady, busy, callActive, panel, emotions }
 *   GET  /panel      → 内嵌视频通话面板页（iframe 用；桌宠直出，含字幕/动画/语音）
 *   GET  /asset/*    → 动画/贴纸（与 petasset:// 同源同逻辑，面板页用）
 *   WS   /events     → pet:* 事件实时广播（JSON {channel, args}；面板同屏字幕/语音）
 *   POST /say        → { text, emotion? } 她把这句话说出来（写进会话上下文）
 *   POST /emote      → { emotion } 做表情动画
 *   POST /call/start → { topic? } 接通视频通话：新会话 + 渲染层切通话视图 + 她先开口
 *   POST /chat       → { text } 以正常用户消息跑一轮，返回她的完整回复文本
 *   POST /call/end   → 挂断（与点挂断按钮同款，会话已自动落盘）
 *   POST /interrupt  → 停止当前播报/对话
 *   POST /quit       → 让桌宠退出
 *   POST /dsh-activity → dsh 插件推送实时活动快照（她答"他在干嘛"的素材 + 面板小条）
 */

const DEFAULT_PORT = 37820
/** 语音录音 base64 很大（60 秒 ≈ 2.5MB），放宽到 16MB；本地信任通道 */
const BODY_LIMIT = 16 * 1024 * 1024
/** /say 里的 TTS 流式合成 + 播放兜底，上限放宽到两分钟 */
const SAY_TIMEOUT_MS = 120_000

export function pluginPort(): number {
  const raw = process.env['PET_PLUGIN_PORT']
  const port = raw ? parseInt(raw, 10) : DEFAULT_PORT
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT
}

function pluginToken(): string {
  return process.env['PET_PLUGIN_TOKEN'] ?? ''
}

/** 桥的关键事件落盘（与 dsh 插件的看门狗日志同一个文件，诊断集中一处）：
 *  打包版 exe 的 stdout 没人能看，没有这个文件 DSH 侧的问题就永远黑箱。 */
export function petLogWS(message: string): void {
  try {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    appendFileSync(process.env.TEMP + '/dsh-pet-watchdog.log', stamp + ' [bridge] ' + message + '\n')
  } catch {
    // 日志写不进去不影响主流程
  }
}

let server: Server | null = null
let wss: WebSocketServer | null = null
const wsClients = new Set<WebSocket>()
/** 事件总线的退订句柄（stopPluginBridge 时摘掉） */
let unsubEvents: (() => void) | null = null
const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}

/** /app/* 路由：把桌宠自己的渲染层页面也服务出去。
 *  打包版 pet 页面原本走 file:// 加载——Electron 里 file:// 的 navigator.mediaDevices
 *  是 undefined（已知问题），麦克风代录在桌宠进程里根本拿不到麦克风。
 *  改走 http://127.0.0.1:port/app/pet/index.html（localhost = 安全上下文），麦克风即可用。 */
function serveAppFile(relPath: string, res: ServerResponse): void {
  const appDir = app.getAppPath() // 指向 app.asar（Electron 的 fs 补丁可直读）
  const base = normalize(join(appDir, 'out/renderer'))
  const full = normalize(join(base, relPath))
  if (!full.startsWith(base + sep) && full !== base) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  const ext = join(full).split('.').pop()!.toLowerCase()
  const type = ASSET_MIME['.' + ext] ?? 'application/octet-stream'
  const data = new Uint8Array(readFileSync(full))
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(data.length),
    'Cache-Control': 'no-cache'
  })
  res.end(data)
}

function wsBroadcast(channel: string, args: unknown[]): void {
  if (wsClients.size === 0) return
  const payload = JSON.stringify({ channel, args })
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload)
  }
}

/** 面板客户端数变化 → 通知平板渲染层静音/恢复（避免双声道） */
function notifyAudioSink(): void {
  const on = wsClients.size > 0
  console.log(`[bridge] 远程面板${on ? '接管' : '交还'}声音（WS 客户端 ${wsClients.size} 个）`)
  getPetWindow()?.webContents.send('pet:bridge-audio-sink', on)
}

function addWsClient(ws: WebSocket): void {
  wsClients.add(ws)
  petLogWS(`WS 面板连接（在线 ${wsClients.size}）`)
  if (wsClients.size === 1) notifyAudioSink()
  ws.on('close', () => {
    wsClients.delete(ws)
    petLogWS(`WS 面板断开（在线 ${wsClients.size}）`)
    if (wsClients.size === 0) notifyAudioSink()
  })
  ws.on('error', () => ws.terminate())
}

/** /asset/* 路由：与 petasset:// 的 serveAsset 同源同逻辑含 Range（面板页 <video> 用）。
 *  素材已随皮肤搬进 skins/ 后，这里对不存在的路径回退当前皮肤目录，panelPage 零改动兼容 */
function serveAssetFile(relPath: string, req: IncomingMessage, res: ServerResponse): void {
  const full = normalize(join(assetRoot(), relPath))
  if (!full.startsWith(assetRoot() + sep) && full !== assetRoot()) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let finalFull = full
  if (!existsSync(full) || !statSync(full).isFile()) {
    const skinFull = normalize(join(activeSkinDir(loadConfig()), relPath))
    if (!skinFull.startsWith(activeSkinDir(loadConfig()) + sep) || !existsSync(skinFull) || !statSync(skinFull).isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    finalFull = skinFull
  }
  const type = ASSET_MIME['.' + join(finalFull).split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'
  const data = new Uint8Array(readFileSync(finalFull))
  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    // 素材热更新后不能吃缓存（与 petasset 协议同款）
    'Cache-Control': 'no-cache'
  }
  const range = req.headers.range
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0
    const end = match[2] ? Math.min(parseInt(match[2], 10), data.length - 1) : data.length - 1
    if (start >= data.length || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` })
      res.end()
      return
    }
    const slice = data.subarray(start, end + 1)
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(slice.length),
      ...baseHeaders
    })
    res.end(slice)
    return
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(data.length),
    ...baseHeaders
  })
  res.end(data)
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  })
  res.end(body)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) return null
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 可选 token：配了 PET_PLUGIN_TOKEN 就要求 `Authorization: Bearer <token>`（WS/GET 允许 ?token= 查询参数） */
function authorized(req: IncomingMessage, query?: URLSearchParams): boolean {
  const token = pluginToken()
  if (!token) return true
  if (req.headers.authorization === `Bearer ${token}`) return true
  if (query && query.get('token') === token) return true
  return false
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedUrl = (req.url ?? '').split('?')
  const url = parsedUrl[0]
  const query = new URLSearchParams(parsedUrl[1] ?? '')
  const isGet = req.method === 'GET'

  if (url === '/health' && isGet) {
    const config = loadConfig()
    // DSH 页面（另一个端口）要跨域读它在不在线，/health 只读、无敏感信息，放开来源
    sendJson(res, 200, {
      ok: true,
      app: 'deskpet-tablet',
      version: app.getVersion(),
      dev: !app.isPackaged,
      ttsReady: isTtsReady(config.tts),
      busy: isTurnActive() || isPatActive(),
      callActive: isCallActive(),
      panel: `http://127.0.0.1:${pluginPort()}/panel`,
      emotions: EMOTIONS
    }, { 'Access-Control-Allow-Origin': '*' })
    return
  }

  // 内嵌面板页：iframe 用（GET 不设防伪头，但配了 token 就要求对上）
  if (url === '/panel' && isGet) {
    if (!authorized(req, query)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const body = panelHtml(pluginPort(), pluginToken())
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache'
      // 刻意不加 X-Frame-Options / frame-ancestors：dsh 桌面端的外壳跑在自定义协议里
      // （dsh-app://），而 CSP 的 `*` 只匹配 http/https/ws/wss，会把面板拦成白屏。
      // 通道本身只监听 127.0.0.1、面板里没有密钥，最坏情况只是本机页面能把它框起来
    })
    res.end(body)
    return
  }

  // 动画/贴纸（面板页用，与 petasset:// 同源逻辑）
  if (url.startsWith('/asset/') && isGet) {
    serveAssetFile(decodeURIComponent(url.slice('/asset/'.length)), req, res)
    return
  }

  // 桌宠自己的渲染层页面（打包版 petWindow 从这里加载：localhost 才有 mediaDevices）
  if (url.startsWith('/app/') && isGet) {
    serveAppFile(decodeURIComponent(url.slice('/app/'.length)), res)
    return
  }

  // 当前会话的近期对话轮（面板页连上时铺聊天记录用；只给可见消息，隐藏消息不出门）
  if (url === '/history' && isGet) {
    if (!authorized(req, query)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const sessions = loadSessions()
    const sessionId = getActiveSessionId()
    const session =
      (sessionId ? sessions.sessions.find((s) => s.id === sessionId) : undefined) ??
      [...sessions.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const messages = session
      ? session.messages
          .filter((m) => !m.hidden)
          .slice(-40)
          .map((m) => ({ role: m.role, content: m.content }))
      : []
    sendJson(res, 200, { ok: true, sessionId: session?.id, title: session?.title, messages })
    return
  }

  // 其余接口一律 POST + 防伪头 + 可选 token
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (req.headers['x-pet-bridge'] !== '1') {
    sendJson(res, 403, { ok: false, error: 'missing x-pet-bridge header' })
    return
  }
  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  const body = await readJson(req)
  if (body === null) {
    sendJson(res, 400, { ok: false, error: 'invalid json body' })
    return
  }

  if (url === '/say') {
    const text = String(body.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'text is required' })
      return
    }
    const emotion = typeof body.emotion === 'string' ? body.emotion : undefined
    if (emotion !== undefined && !(EMOTIONS as readonly string[]).includes(emotion)) {
      sendJson(res, 400, { ok: false, error: `unknown emotion, see /health emotions`, emotions: EMOTIONS })
      return
    }
    if (isTurnActive() || isPatActive()) {
      sendJson(res, 409, { ok: false, busy: true, error: '她正在通话/播报中' })
      return
    }
    try {
      const result = await Promise.race([
        petSay({ petWindow: getPetWindow(), config: loadConfig(), text, emotion, remote: true }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SAY_TIMEOUT_MS))
      ])
      if (result === null) {
        sendJson(res, 504, { ok: false, error: '播报超时' })
        return
      }
      if (!result.ok) {
        sendJson(res, result.busy ? 409 : 400, { ...result, error: result.busy ? '她正在通话中' : '播报失败' })
        return
      }
      sendJson(res, 200, result)
    } catch (error) {
      console.error('[bridge] /say', error)
      sendJson(res, 500, { ok: false, error: (error as Error).message })
    }
    return
  }

  if (url === '/emote') {
    const emotion = String(body.emotion ?? '')
    if (!(EMOTIONS as readonly string[]).includes(emotion)) {
      sendJson(res, 400, { ok: false, error: `unknown emotion`, emotions: EMOTIONS })
      return
    }
    // 远程来源：她在 DSH 面板里做表情，桌面平板保持胶囊态不弹出
    getPetWindow()?.webContents.send('pet:emotion', emotion)
    sendJson(res, 200, { ok: true })
    return
  }

  // ---------- 视频通话（与主界面「开始视频通话」同一条链路） ----------

  if (url === '/call/start') {
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    if (isCallActive()) {
      // 幂等：已经在通话里，报当前会话即可
      sendJson(res, 200, { ok: true, already: true, sessionId: getActiveSessionId(), topic })
      return
    }
    if (isTurnActive() || isPatActive()) {
      sendJson(res, 409, { ok: false, busy: true, error: '她正在播报/对话中，稍后再接通' })
      return
    }
    // 新会话 + 主题，渲染层切到通话视图（不抢焦点，要不要聊由用户自己点）
    const store = loadSessions()
    const session = newSession(topic)
    store.sessions.unshift(session)
    saveSessions(store)
    setActiveSession(session.id)
    getPetWindow()?.webContents.send('pet:call-start', { sessionId: session.id, topic })
    // 她围绕主题先开口（opening 走 runTurn，灵动岛胶囊态会自动现形）
    void runTurn({ petWindow: getPetWindow(), config: loadConfig(), sessionId: session.id, opening: topic, remote: true })
    sendJson(res, 200, { ok: true, sessionId: session.id, topic })
    return
  }

  if (url === '/call/end') {
    if (!isCallActive()) {
      sendJson(res, 400, { ok: false, error: '当前没有进行中的通话' })
      return
    }
    const sessionId = getActiveSessionId()
    cancelActiveTurn() // 她说到一半也停（与用户点挂断同款行为）
    getPetWindow()?.webContents.send('pet:call-end')
    const messages = sessionId
      ? (loadSessions().sessions.find((s) => s.id === sessionId)?.messages.length ?? 0)
      : 0
    sendJson(res, 200, { ok: true, sessionId, messages })
    return
  }

  if (url === '/chat') {
    const text = String(body.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'text is required' })
      return
    }
    if (isTurnActive() || isPatActive()) {
      sendJson(res, 409, { ok: false, busy: true, error: '她正在说话，等这轮结束再发' })
      return
    }
    noteUserActivity() // 主动开口的闲置计时刷新（与 pet:send 一致）
    try {
      const outcome = await Promise.race([
        chatExternal(getPetWindow(), loadConfig(), text),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SAY_TIMEOUT_MS))
      ])
      const reply = outcome === null ? null : outcome.reply
      if (!reply) {
        sendJson(res, 502, { ok: false, error: '这轮没等到回复（被打断或失败了）' })
        return
      }
      sendJson(res, 200, { ok: true, reply })
    } catch (error) {
      console.error('[bridge] /chat', error)
      sendJson(res, 500, { ok: false, error: (error as Error).message })
    }
    return
  }

  if (url === '/interrupt') {
    cancelActiveTurn()
    cancelPat()
    sendJson(res, 200, { ok: true })
    return
  }

  // dsh 实时活动快照：插件在 dsh 干活时推送（防抖过），存起来给她的大脑拼 system
  // prompt（用户问"他在干嘛"她就能讲），同时广播给面板显示状态小条。纯旁路，幂等覆盖。
  if (url === '/dsh-activity') {
    const snapshot = setDshActivity(body)
    if (snapshot) wsBroadcast('pet:dsh-activity', [snapshot])
    sendJson(res, 200, { ok: snapshot !== null })
    return
  }

  // 摸摸头/点点屏幕（面板双击用）：zone=head 摸头，其余=点屏幕
  if (url === '/pat') {
    if (isTurnActive() || isPatActive()) {
      sendJson(res, 409, { ok: false, busy: true, error: '她正在说话' })
      return
    }
    void petPat(getPetWindow(), loadConfig(), body.zone === 'head' ? 'head' : 'body')
    sendJson(res, 200, { ok: true })
    return
  }

  if (url === '/mic/start' || url === '/mic/stop') {
    sendJson(res, 501, { ok: false, error: '语音输入功能已移除' })
    return
  }

  if (url === '/asr') {
    sendJson(res, 501, { ok: false, error: '语音输入功能已移除' })
    return
  }


  if (url === '/quit') {
    sendJson(res, 200, { ok: true })
    setTimeout(() => app.quit(), 100) // 先回完包再退
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

/** app ready 后调用；端口冲突多半是已有实例在跑，桥不重复起，不影响主流程 */
export function startPluginBridge(): void {
  const port = pluginPort()
  if (!port) {
    console.log('[bridge] PET_PLUGIN_PORT=0，控制桥已关闭')
    return
  }
  const next = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error('[bridge]', error)
      try {
        sendJson(res, 500, { ok: false, error: (error as Error).message })
      } catch {
        // 响应已经写过头了，算了
      }
    })
  })
  next.on('error', (error) => console.error('[bridge] listen failed:', (error as Error).message))

  // WS /events：面板等远程视图订阅 pet:* 事件流（JSON {channel, args}）
  const sockets = new WebSocketServer({ noServer: true })
  next.on('upgrade', (req, socket, head) => {
    const [path, search] = (req.url ?? '').split('?')
    if (path !== '/events') {
      socket.destroy()
      return
    }
    if (!authorized(req, new URLSearchParams(search ?? ''))) {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => addWsClient(ws))
  })
  sockets.on('error', (error) => console.error('[bridge] ws:', (error as Error).message))
  wss = sockets

  // 事件总线 → WS 广播。订阅放在 listen 之前：面板一接上就能收到开场白
  unsubEvents = onPetEvent((channel, args) => wsBroadcast(channel, args))

  next.listen(port, '127.0.0.1', () => console.log(`[bridge] 127.0.0.1:${port} 就绪`))
  server = next
}

export function stopPluginBridge(): void {
  unsubEvents?.()
  unsubEvents = null
  for (const client of wsClients) {
    try {
      client.close()
    } catch {
      // 已经断了
    }
  }
  if (wsClients.size > 0) {
    wsClients.clear()
    notifyAudioSink() // 面板都关了：平板声音还回去
  }
  wss?.close()
  wss = null
  server?.close()
  server = null
}
