import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, openSync, writeFileSync, statSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { app } from 'electron'
import { TTSConfig } from '../../shared/types'

/**
 * GPT-SoVITS 本地语音服务自动拉起：应用启动 / 合成发现服务不在线时，后台直接拉起 python。
 * ⚠ 实测教训：不要经由 cmd/bat 拉起——中文文件名在 verbatim spawn → cmd → start 链里会被
 *   解析坏，bat 内容的中文也依赖 chcp 时序容易解析崩；直接 spawn runtime\python.exe，
 *   cwd 指到整合包目录，全部输出落 userData/logs/gsv-autostart.log，起不来一查便知。
 *
 * 显存治理：实例是 detached 的（应用退出也活着），角色多了会各占一份显存。
 * 台账 userData/data/gsv-spawned.json 记下每次拉起的 {端口, pid, 推理配置}；
 * 换角色/启动时由 stopSpawnedGsvExcept 清掉"除当前角色外自己拉起的实例"。
 * 安全边界：只清理台账里的（= 本应用拉的），且杀前用 netstat 核对该 pid 确实还占着
 * 那个端口；用户手动开的（bat/命令行）没有台账，永远不碰。
 */

const DEFAULT_LAUNCHER = 'D:\\GPT-SoVITS\\GPT-SoVITS-v2pro-20261006nvidia50x0\\yeshung-voice.bat'

/** 每个规范化服务地址独立冷却，切角色端口不会被旧实例的启动记录阻挡。 */
const lastLaunchAt = new Map<string, number>()

/** 本应用拉起的实例台账：detached 进程跨运行存活，靠它跨运行认领"自己人" */
interface GsvSpawnRecord {
  base: string
  pid: number
  port: string
  inferConfig: string
  spawnedAt: number
}

function spawnLedgerPath(): string {
  return join(app.getPath('userData'), 'data', 'gsv-spawned.json')
}

function readSpawnLedger(): GsvSpawnRecord[] {
  try {
    const raw = JSON.parse(readFileSync(spawnLedgerPath(), 'utf-8')) as GsvSpawnRecord[]
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.pid === 'number' && typeof r.base === 'string') : []
  } catch {
    return []
  }
}

function writeSpawnLedger(records: GsvSpawnRecord[]): void {
  try {
    mkdirSync(dirname(spawnLedgerPath()), { recursive: true })
    writeFileSync(spawnLedgerPath(), JSON.stringify(records, null, 2), 'utf-8')
  } catch {
    // 台账写不进去只影响跨运行清理，不影响功能
  }
}

function recordSpawn(base: string, pid: number, port: string, inferConfig: string): void {
  const records = readSpawnLedger().filter((r) => r.base !== base)
  records.push({ base, pid, port, inferConfig, spawnedAt: Date.now() })
  writeSpawnLedger(records)
}

function normalizedBase(config: TTSConfig): string {
  return new URL(config.gsvApiBase || 'http://127.0.0.1:9880').href.replace(/\/+$/, '')
}

function assertConfigFile(file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`GPT-SoVITS 推理配置不存在：${file}`)
  }
}

export async function isGsvOnline(apiBase: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const response = await fetch(apiBase, { signal: controller.signal })
    clearTimeout(timer)
    return true // 只要通（哪怕 404/405）就说明 api_v2 活着
  } catch {
    return false
  }
}

function gsvLogPath(): string {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'gsv-autostart.log')
}

/** 等本地语音服务就绪（在线即视为可用：uvicorn 监听后请求会排队，首推理 ~30s 内 60s 超时扛得住）。
 *  字声同步用：本轮首句合成前调用，最多等 maxWaitMs，可被取消。返回实际等待毫秒数（0=本来就在线）。
 *  超时不抛错——交还给正常合成路径自己失败/报错，这里只负责"能等则等"。 */
export async function waitForGsvOnline(config: TTSConfig, maxWaitMs: number, signal?: AbortSignal): Promise<number> {
  if (!config.enabled || config.provider !== 'gptsovits') return 0
  const base = normalizedBase(config)
  const started = Date.now()
  if (await isGsvOnline(base)) return 0
  while (Date.now() - started < maxWaitMs) {
    if (signal?.aborted) throw new Error('已取消')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (await isGsvOnline(base)) return Date.now() - started
  }
  return Date.now() - started
}

/** 服务在线就直接 true；不在线则后台拉起整合包 python（返回是否发起了启动） */
export async function ensureGsvService(config: TTSConfig): Promise<boolean> {
  if (!config.enabled || config.provider !== 'gptsovits') return false
  const base = normalizedBase(config)
  // 整合包目录只取全局可信启动器；皮肤只能指定经过 resolver 校验的推理配置。
  const gsvDir = dirname(config.gsvLauncherPath?.trim() || DEFAULT_LAUNCHER)
  const customConfig = config.gsvConfigPath
  if (customConfig !== undefined && !customConfig.trim()) throw new Error('GPT-SoVITS 推理配置路径不能为空')
  const inferConfig = resolve(gsvDir, customConfig ?? 'GPT_SoVITS/configs/tts_infer.yaml')
  // 专属配置缺失时，即使端口在线也不能掩盖错误，更不能退回共享模型。
  if (customConfig !== undefined) assertConfigFile(inferConfig)
  if (await isGsvOnline(base)) return true
  const previousLaunch = lastLaunchAt.get(base)
  if (previousLaunch !== undefined && Date.now() - previousLaunch < 5 * 60_000) return false
  assertConfigFile(inferConfig)

  const python = join(gsvDir, 'runtime', 'python.exe')
  if (!existsSync(python)) {
    console.error('[gsv] 自动拉起跳过：找不到整合包 python：', python)
    return false
  }

  // 端口和 loopback 监听地址跟随当前实例（未显式写端口时按 HTTP 默认端口）。
  const parsed = new URL(base)
  const port = parsed.port || '80'
  const host = parsed.hostname === '[::1]' ? '::1'
    : /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname) ? parsed.hostname : '127.0.0.1'

  lastLaunchAt.set(base, Date.now())
  const log = gsvLogPath()
  try {
    writeFileSync(log, `\r\n===== 自动拉起 ${new Date().toLocaleString()} =====\r\n`, { flag: 'a' })
  } catch {
    // 日志写不进去不影响拉起
  }
  const logFd = openSync(log, 'a')
  const child = spawn(
    python,
    ['api_v2.py', '-a', host, '-p', port, '-c', inferConfig],
    {
      cwd: gsvDir, detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd],
      // 整合包内旧版 httpx 无法解析继承环境中的 IPv6 NO_PROXY 条目。
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
    }
  )
  child.on('error', (error) => console.error('[gsv] 自动拉起失败:', error.message))
  child.unref()
  if (child.pid) recordSpawn(base, child.pid, port, inferConfig) // 记台账：跨运行也认得出是自己拉的
  console.error('[gsv] 语音服务不在线，已后台拉起 python（日志：', log, '）')
  return true
}

/** 核对该 pid 确实还占着那个端口的监听（防 pid 复用误杀） */
function pidOwnsListeningPort(pid: number, port: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(false)
      for (const line of String(stdout).split('\n')) {
        if (!/\s(TCP|UDP)\s/i.test(line)) continue
        if (!/LISTENING/i.test(line)) continue
        const columns = line.trim().split(/\s+/)
        // netstat -ano 列序：协议 / 本地地址 / 远地地址 / 状态 / pid
        if (columns.length < 5) continue
        const local = columns[1] ?? ''
        if (local.endsWith(`:${port}`) && Number(columns[columns.length - 1]) === pid) return resolve(true)
      }
      resolve(false)
    })
  })
}

function taskKillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/**
 * 只停掉本应用拉起的、除 keepBase 之外的 GSV 实例（省显存）。
 * 两种该杀的形态：①pid 仍占着那个端口的 LISTENING（在役）；②近期（10 分钟内）拉起但还没监听
 * ——那是卡在 torch 导入/模型加载中，不杀的话加载完成后端口一绑就"复活"逃过清理
 * （角色越多这个漏网越致命）。宽限期内 pid 复用概率极低（Windows pid 递增分配）。
 * 已死进程（既不在监听又超宽限期）的台账条目顺带清掉。
 */
export async function stopSpawnedGsvExcept(keepBase: string): Promise<string[]> {
  const keep = new URL(keepBase).href.replace(/\/+$/, '')
  const stopped: string[] = []
  const remaining: GsvSpawnRecord[] = []
  for (const record of readSpawnLedger()) {
    if (record.base === keep) {
      remaining.push(record)
      continue
    }
    const listening = await pidOwnsListeningPort(record.pid, record.port)
    const fresh = Date.now() - record.spawnedAt < 10 * 60_000
    if (listening || fresh) {
      await taskKillTree(record.pid)
      stopped.push(record.base)
      // 是我们主动杀的，不是启动风暴：清掉启动冷却，切回来时允许立刻重新拉起
      lastLaunchAt.delete(record.base)
      console.log('[gsv] 已停掉闲置的语音实例（省显存）:', record.base, 'pid', record.pid, listening ? '(在役)' : '(加载中)')
    } else {
      // 没在监听又超宽限期 = 确实早已退出：台账条目就此作废，冷却一并作废
      lastLaunchAt.delete(record.base)
    }
  }
  writeSpawnLedger(remaining)
  return stopped
}

/** 启动预热：拉起本地语音服务并空合成一小句，把模型先装进显存——用户第一句话不再冷启动 */
export async function warmUpGsv(config: TTSConfig): Promise<void> {
  if (!config.enabled || config.provider !== 'gptsovits') return
  try {
    const base = normalizedBase(config)
    const launched = await ensureGsvService(config)
    if (launched) {
      // 刚拉起整合包：等服务真正开始监听（最多约 150s），再做预热合成
      for (let i = 0; i < 50; i++) {
        if (await isGsvOnline(base)) break
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000) // 冷启动含模型加载，放宽到 120s
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        text: '你好',
        text_lang: config.gsvTextLang || 'zh',
        ref_audio_path: config.gsvRefAudio,
        prompt_text: config.gsvRefText,
        prompt_lang: config.gsvPromptLang || 'zh',
        text_split_method: 'cut0',
        streaming_mode: false,
        media_type: 'wav',
        speed_factor: Math.min(1.65, Math.max(0.6, config.speed || 1))
      })
    })
    await response.arrayBuffer().catch(() => undefined) // 音频直接丢弃，只为预热
    clearTimeout(timer)
    console.log('[gsv] 预热完成，模型已就绪')
  } catch (error) {
    console.log('[gsv] 预热未完成（不影响使用，首次合成仍会自动拉起服务）:', (error as Error).message)
  }
}
