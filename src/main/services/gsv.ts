import { spawn } from 'child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { TTSConfig } from '../../shared/types'

/**
 * GPT-SoVITS 本地语音服务自动拉起：应用启动 / 合成发现服务不在线时，后台直接拉起 python。
 * ⚠ 实测教训：不要经由 cmd/bat 拉起——中文文件名在 verbatim spawn → cmd → start 链里会被
 *   解析坏，bat 内容的中文也依赖 chcp 时序容易解析崩；直接 spawn runtime\python.exe，
 *   cwd 指到整合包目录，全部输出落 userData/logs/gsv-autostart.log，起不来一查便知。
 */

const DEFAULT_LAUNCHER = ''

/** 同一次运行里拉起过就不再重复，5 分钟冷却兜底 */
let lastLaunchAt = 0

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

/** 服务在线就直接 true；不在线则后台拉起整合包 python（返回是否发起了启动） */
export async function ensureGsvService(config: TTSConfig): Promise<boolean> {
  if (!config.enabled || config.provider !== 'gptsovits') return false
  const base = (config.gsvApiBase || 'http://127.0.0.1:9880').replace(/\/+$/, '')
  if (await isGsvOnline(base)) return true
  if (Date.now() - lastLaunchAt < 5 * 60_000) return false

  // 整合包目录 = 启动脚本所在目录（脚本只是 cd + 跑 runtime\python.exe）
  const gsvDir = dirname(config.gsvLauncherPath?.trim() || DEFAULT_LAUNCHER)
  const python = join(gsvDir, 'runtime', 'python.exe')
  if (!existsSync(python)) {
    console.error('[gsv] 自动拉起跳过：未找到整合包 python——请先在设置里填 GPT-SoVITS 整合包路径，或检查路径是否为纯英文：', python)
    return false
  }

  // 端口跟随配置的 gsvApiBase（默认 9880）
  let port = '9880'
  try {
    const parsed = new URL(base)
    if (parsed.port) port = parsed.port
  } catch {
    // 用默认端口
  }

  lastLaunchAt = Date.now()
  const log = gsvLogPath()
  try {
    writeFileSync(log, `\r\n===== 自动拉起 ${new Date().toLocaleString()} =====\r\n`, { flag: 'a' })
  } catch {
    // 日志写不进去不影响拉起
  }
  const logFd = openSync(log, 'a')
  const child = spawn(
    python,
    ['api_v2.py', '-a', '127.0.0.1', '-p', port, '-c', 'GPT_SoVITS\\configs\\tts_infer.yaml'],
    { cwd: gsvDir, detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] }
  )
  child.on('error', (error) => console.error('[gsv] 自动拉起失败:', error.message))
  child.unref()
  console.error('[gsv] 语音服务不在线，已后台拉起 python（日志：', log, '）')
  return true
}
