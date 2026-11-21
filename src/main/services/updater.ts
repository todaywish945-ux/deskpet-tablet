import { app, net, shell, WebContents } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { once } from 'events'
import type { UpdateCheckResult, UpdateDownloadResult } from '../../shared/types'

/** 开源发布仓库：检查更新 / 下载安装包都走它的 Releases */
const REPO = 'todaywish945-ux/deskpet-tablet'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
/** 安装包资产命名约定（release 流程定的）：qiaoqiao-setup-<package.json 版本>.exe。
 *  版本对比就用文件名里的这个号——tag（v1.2.x）和包版本（0.1.x）刻意不同轨，别拿 tag 比 */
const ASSET_NAME_RE = /qiaoqiao-setup-(\d+\.\d+\.\d+)\.exe/
/** 直连失败自动套的镜像前缀。镜像服务更迭频繁（2026-11-21 实测 gh-proxy.com 已变成混淆页，
 *  ghproxy.net 活着且能代理页面+资产），换镜像时先跑 scripts/probe-update-mirrors.mjs 验证 */
const MIRROR = 'https://ghproxy.net/'

interface UpdateAsset {
  name: string
  version: string
  url: string
  size: number
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

// 全部走 net.fetch（Chromium 网络栈 + 系统证书库）：Node 的 fetch 会撞 TLS 重签
// （火绒类安全软件拦截 GitHub 域名，node/undici 不认系统证书直接失败，PowerShell/浏览器不受影响）
async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await net.fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 主路：GitHub API 一次拿齐 release 页地址 + 资产列表 */
async function fetchLatestViaApi(): Promise<{ releaseUrl: string; asset: UpdateAsset | null }> {
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deskpet-tablet-updater' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
  const data = (await response.json()) as {
    html_url?: string
    assets?: { name?: string; browser_download_url?: string; size?: number }[]
  }
  const assets = Array.isArray(data.assets) ? data.assets : []
  let asset: UpdateAsset | null = null
  for (const item of assets) {
    const name = String(item.name ?? '')
    const match = ASSET_NAME_RE.exec(name)
    if (match) {
      asset = { name, version: match[1], url: String(item.browser_download_url ?? ''), size: Number(item.size ?? 0) }
      break
    }
  }
  return { releaseUrl: String(data.html_url || RELEASES_PAGE), asset }
}

/** API 被墙时的兜底：镜像抓 latest 跳转页拿 tag，再抓 expanded_assets 页拿安装包名 */
async function fetchLatestViaPage(): Promise<{ releaseUrl: string; asset: UpdateAsset | null }> {
  const page = await fetchText(MIRROR + RELEASES_PAGE, 20_000)
  const tag = /releases\/tag\/(v\d+\.\d+\.\d+)/.exec(page)?.[1]
  if (!tag) throw new Error('镜像页面里没找到版本号')
  const list = await fetchText(`${MIRROR}https://github.com/${REPO}/releases/expanded_assets/${tag}`, 20_000)
  const match = ASSET_NAME_RE.exec(list)
  if (!match) throw new Error('镜像页面里没找到安装包')
  return {
    releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    asset: {
      name: match[0],
      version: match[1],
      url: `https://github.com/${REPO}/releases/download/${tag}/${match[0]}`,
      size: 0
    }
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  let lastError: unknown = null
  for (const fetcher of [fetchLatestViaApi, fetchLatestViaPage]) {
    const viaMirror = fetcher === fetchLatestViaPage
    try {
      const { releaseUrl, asset } = await fetcher()
      if (!asset) {
        return { ok: true, currentVersion, version: null, hasUpdate: false, releaseUrl, assetName: null, downloadUrl: null, size: null, viaMirror }
      }
      return {
        ok: true,
        currentVersion,
        version: asset.version,
        hasUpdate: compareVersions(asset.version, currentVersion) > 0,
        releaseUrl,
        assetName: asset.name,
        downloadUrl: asset.url,
        size: asset.size,
        viaMirror
      }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    currentVersion,
    version: null,
    hasUpdate: false,
    releaseUrl: RELEASES_PAGE,
    assetName: null,
    downloadUrl: null,
    size: null,
    viaMirror: false,
    error: `连不上 GitHub（${lastError instanceof Error ? lastError.message : '网络异常'}）`
  }
}

// ---------- 下载 ----------

let downloadedInstallerPath: string | null = null
let activeDownload: AbortController | null = null
let cancelRequested = false

export interface DownloadProgress {
  received: number
  total: number
}

/** 流式下载最新安装包到临时目录，进度经 sender 推给设置窗口；直连失败自动换镜像重下 */
export async function downloadLatestInstaller(sender: WebContents): Promise<UpdateDownloadResult> {
  const info = await checkForUpdate()
  if (!info.ok || !info.downloadUrl) return { ok: false, error: info.error ?? '没有可下载的新版本' }
  if (!info.hasUpdate) return { ok: false, error: '当前已是最新版本' }

  const dir = join(app.getPath('temp'), 'deskpet-update')
  await mkdir(dir, { recursive: true })
  const target = join(dir, info.assetName!)
  const attempts = [
    { url: info.downloadUrl, viaMirror: false },
    { url: MIRROR + info.downloadUrl, viaMirror: true }
  ]
  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      const received = await streamToFile(attempt.url, target, sender)
      if (info.size && received < info.size) throw new Error(`下载不完整（${received}/${info.size} 字节）`)
      downloadedInstallerPath = target
      return { ok: true, path: target, viaMirror: attempt.viaMirror }
    } catch (error) {
      lastError = error
      if (cancelRequested) {
        cancelRequested = false
        return { ok: false, error: '已取消下载' }
      }
    }
  }
  return { ok: false, error: `下载失败：${lastError instanceof Error ? lastError.message : '网络异常'}` }
}

async function streamToFile(url: string, target: string, sender: WebContents): Promise<number> {
  const controller = new AbortController()
  activeDownload = controller
  // 30 秒没有任何新字节就掐断（上层自动换镜像重试）
  let lastByteAt = Date.now()
  const stallTimer = setInterval(() => {
    if (Date.now() - lastByteAt > 30_000) controller.abort()
  }, 5_000)
  const out = createWriteStream(target)
  let received = 0
  let emittedAt = 0
  const emit = (total: number, force = false): void => {
    const now = Date.now()
    if ((force || now - emittedAt > 400) && !sender.isDestroyed()) {
      emittedAt = now
      sender.send('update:progress', { received, total })
    }
  }
  try {
    const response = await net.fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    for await (const chunk of response.body) {
      const bytes = chunk as Uint8Array
      received += bytes.length
      lastByteAt = Date.now()
      if (!out.write(bytes)) await once(out, 'drain')
      emit(total)
    }
    out.end()
    await once(out, 'finish')
    emit(total, true)
    return received
  } catch (error) {
    out.destroy()
    throw error
  } finally {
    clearInterval(stallTimer)
    if (activeDownload === controller) activeDownload = null
  }
}

export function cancelDownload(): void {
  cancelRequested = true
  activeDownload?.abort()
}

/** 启动已下载的 NSIS 安装包静默升级（/S；安装器会等本实例退出再覆盖文件） */
export async function installDownloadedInstaller(): Promise<UpdateDownloadResult> {
  if (!downloadedInstallerPath || !existsSync(downloadedInstallerPath)) {
    return { ok: false, error: '安装包还没下载' }
  }
  const installer = downloadedInstallerPath
  let spawnError = ''
  const started = await new Promise<boolean>((resolve) => {
    const child = spawn(installer, ['/S'], { detached: true, stdio: 'ignore', cwd: dirname(installer) })
    child.once('spawn', () => resolve(true))
    child.once('error', (error) => {
      spawnError = String(error)
      resolve(false)
    })
  })
  if (!started) return { ok: false, error: `安装器启动失败（${spawnError}）` }
  // 正常走 before-quit 清理（GSV 收尾等），NSIS 那边会等我们退完再覆盖
  app.quit()
  return { ok: true, path: installer }
}

/** 打开 Releases 页面（只放行我们自己的两个域，别当通用 openURL 用） */
export function openReleasePage(url: string): void {
  const target = /^https:\/\/(github\.com|gh-proxy\.com)\//.test(url) ? url : RELEASES_PAGE
  void shell.openExternal(target)
}
