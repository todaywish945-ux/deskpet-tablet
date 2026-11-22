import { app, net, shell, WebContents } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import { once } from 'events'
import type { UpdateCheckResult, UpdateDownloadResult } from '../../shared/types'

/** 开源发布仓库：检查更新 / 下载安装包 / 下载角色包都走它的 Releases */
const REPO = 'todaywish945-ux/deskpet-tablet'
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
/** 安装包资产命名约定（release 流程定的）：qiaoqiao-setup-<package.json 版本>.exe。
 *  版本对比就用文件名里的这个号——tag（v1.2.x）和包版本（0.1.x）刻意不同轨，别拿 tag 比 */
export const ASSET_NAME_RE = /qiaoqiao-setup-(\d+\.\d+\.\d+)\.exe/
/** 直连失败依序套的镜像前缀。镜像服务更迭频繁（2026-11-21 实测：gh-proxy.com 页面代理返回
 *  混淆 JS 页但**文件代理快**（3.3MB/s vs ghproxy.net 劣化到 29KB/s）；ghproxy.net 页面可用但
 *  间歇 500。下载链路直连→两个镜像依序试 + 测速感知自动跳过慢的；换镜像先跑
 *  scripts/probe-update-mirrors.mjs 验证 */
export const MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/']

export interface ReleaseAsset {
  name: string
  url: string
  size: number
}

export interface ReleaseInfo {
  releaseUrl: string
  assets: ReleaseAsset[]
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff) return diff > 0 ? 1 : -1
  }
  return 0
}

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

// 全部走 net.fetch（Chromium 网络栈 + 系统证书库）：Node 的 fetch 会撞 TLS 重签
// （火绒类安全软件拦截 GitHub 域名，node/undici 不认系统证书直接失败，PowerShell/浏览器不受影响）

/** 主路：GitHub API 一次拿齐 release 页地址 + 完整资产列表 */
async function fetchLatestViaApi(): Promise<ReleaseInfo> {
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'deskpet-tablet-updater' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
  const data = (await response.json()) as {
    html_url?: string
    assets?: { name?: string; browser_download_url?: string; size?: number }[]
  }
  const assets = (Array.isArray(data.assets) ? data.assets : [])
    .map((item) => ({ name: String(item.name ?? ''), url: String(item.browser_download_url ?? ''), size: Number(item.size ?? 0) }))
    .filter((item) => item.name)
  return { releaseUrl: String(data.html_url || RELEASES_PAGE), assets }
}

/** API 被墙时的兜底：镜像抓 latest 跳转页拿 tag，再抓 expanded_assets 页拿资产文件名（拿不到大小）。
 *  多个镜像依序试：有的镜像页面代理坏（返回混淆页/500），有的好，谁的页面里能抠出 tag 用谁 */
async function fetchLatestViaPage(): Promise<ReleaseInfo> {
  let lastError: unknown = null
  for (const mirror of MIRRORS) {
    try {
      const page = await fetchText(mirror + RELEASES_PAGE, 20_000)
      const tag = /releases\/tag\/(v\d+\.\d+\.\d+)/.exec(page)?.[1]
      if (!tag) throw new Error('镜像页面里没找到版本号')
      const list = await fetchText(`${mirror}https://github.com/${REPO}/releases/expanded_assets/${tag}`, 20_000)
      const assets: ReleaseAsset[] = []
      const seen = new Set<string>()
      const re = new RegExp(`releases/download/${tag}/([A-Za-z0-9._-]+)`, 'g')
      for (const match of list.matchAll(re)) {
        const name = match[1]
        if (seen.has(name)) continue
        seen.add(name)
        assets.push({ name, url: `https://github.com/${REPO}/releases/download/${tag}/${name}`, size: 0 })
      }
      return { releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`, assets }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('所有镜像的页面兜底都不可用')
}

export async function fetchLatestRelease(): Promise<{ ok: boolean; info: ReleaseInfo | null; viaMirror: boolean; error?: string }> {
  let lastError: unknown = null
  for (const fetcher of [fetchLatestViaApi, fetchLatestViaPage]) {
    const viaMirror = fetcher === fetchLatestViaPage
    try {
      return { ok: true, info: await fetcher(), viaMirror }
    } catch (error) {
      lastError = error
    }
  }
  return {
    ok: false,
    info: null,
    viaMirror: false,
    error: `连不上 GitHub（${lastError instanceof Error ? lastError.message : '网络异常'}）`
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const release = await fetchLatestRelease()
  if (!release.ok || !release.info) {
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
      error: release.error
    }
  }
  const asset = release.info.assets.find((item) => ASSET_NAME_RE.test(item.name))
  if (!asset) {
    return { ok: true, currentVersion, version: null, hasUpdate: false, releaseUrl: release.info.releaseUrl, assetName: null, downloadUrl: null, size: null, viaMirror: release.viaMirror }
  }
  const version = ASSET_NAME_RE.exec(asset.name)![1]
  return {
    ok: true,
    currentVersion,
    version,
    hasUpdate: compareVersions(version, currentVersion) > 0,
    releaseUrl: release.info.releaseUrl,
    assetName: asset.name,
    downloadUrl: asset.url,
    size: asset.size,
    viaMirror: release.viaMirror
  }
}

// ---------- 下载（安装包与角色包共用的流式管线） ----------

export interface DownloadProgress {
  received: number
  total: number
}

/**
 * 流式下载到 target：30 秒无新字节掐断（调用方换镜像重试），
 * 进度经 onProgress 回调（约 400ms 一拍 + 收尾强制一拍）。
 */
export async function streamToFile(
  url: string,
  target: string,
  controller: AbortController,
  onProgress: (progress: DownloadProgress) => void,
  opts?: { speedWatch?: boolean }
): Promise<number> {
  let lastByteAt = Date.now()
  const stallTimer = setInterval(() => {
    if (Date.now() - lastByteAt > 30_000) controller.abort()
  }, 5_000)
  const out = createWriteStream(target)
  let received = 0
  let emittedAt = 0
  // 测速感知：起步 12 秒后平均速度仍低于 400KB/s，就掐掉让调用方换线路重试
  // （直连 GitHub 国内常见 300KB/s 上下，镜像往往快得多；"慢而不断"不该让用户干等）
  const startedAt = Date.now()
  const SLOW_SPEED_BPS = 400 * 1024
  const SPEED_GRACE_MS = 12_000
  let slowFlag = false
  const emit = (total: number, force = false): void => {
    const now = Date.now()
    if (force || now - emittedAt > 400) {
      emittedAt = now
      onProgress({ received, total })
    }
    const elapsed = now - startedAt
    if ((!opts || opts.speedWatch !== false) && !slowFlag && elapsed > SPEED_GRACE_MS && received / (elapsed / 1000) < SLOW_SPEED_BPS) {
      slowFlag = true
      controller.abort()
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
    // 测速掐断换成明确信号，调用方按"换线路"处理而不是当失败文案甩给用户
    if (slowFlag) throw new Error('SLOW_CHANNEL')
    throw error
  } finally {
    clearInterval(stallTimer)
  }
}

// ---------- 启动提醒：主界面设置按钮上的「可更新」圆点 ----------

let cachedNotice: { hasUpdate: boolean; version: string | null; checkedAt: number } | null = null

/** 静默检查一次并缓存结果（失败也缓存，失败状态不打扰主界面） */
export async function refreshUpdateNotice(): Promise<void> {
  try {
    const info = await checkForUpdate()
    cachedNotice = { hasUpdate: info.ok && info.hasUpdate, version: info.version, checkedAt: Date.now() }
  } catch {
    cachedNotice = { hasUpdate: false, version: null, checkedAt: Date.now() }
  }
}

export function getUpdateNotice(): { hasUpdate: boolean; version: string | null; checkedAt: number } | null {
  return cachedNotice
}

let downloadedInstallerPath: string | null = null
let activeDownload: AbortController | null = null
let cancelRequested = false

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
    ...MIRRORS.map((mirror) => ({ url: mirror + info.downloadUrl, viaMirror: true }))
  ]
  let lastError: unknown = null
  for (const attempt of attempts) {
    const controller = new AbortController()
    activeDownload = controller
    try {
      const received = await streamToFile(attempt.url, target, controller, (progress) => {
        if (!sender.isDestroyed()) sender.send('update:progress', progress)
      })
      if (info.size && received < info.size) throw new Error(`下载不完整（${received}/${info.size} 字节）`)
      downloadedInstallerPath = target
      return { ok: true, path: target, viaMirror: attempt.viaMirror }
    } catch (error) {
      if (cancelRequested) {
        cancelRequested = false
        return { ok: false, error: '已取消下载' }
      }
      // 测速掐断（SLOW_CHANNEL）：换下一线路静默重试；两路都慢才落到保底段
      lastError = (error as Error).message === 'SLOW_CHANNEL' ? new Error('SLOW_CHANNEL') : error
    }
  }
  // 保底：直连和镜像都被测速掐断 → 回直连关掉测速慢慢下完（慢速完成也总比拿不到强）
  if (lastError instanceof Error && lastError.message === 'SLOW_CHANNEL') {
    const controller = new AbortController()
    activeDownload = controller
    try {
      const received = await streamToFile(info.downloadUrl, target, controller, (progress) => {
        if (!sender.isDestroyed()) sender.send('update:progress', progress)
      }, { speedWatch: false })
      if (info.size && received < info.size) throw new Error(`下载不完整（${received}/${info.size} 字节）`)
      downloadedInstallerPath = target
      return { ok: true, path: target, viaMirror: false }
    } catch (error) {
      if (cancelRequested) {
        cancelRequested = false
        return { ok: false, error: '已取消下载' }
      }
      lastError = error
    }
  }
  activeDownload = null
  const reason = lastError instanceof Error ? lastError.message : '网络异常'
  return { ok: false, error: `下载失败：${reason === 'SLOW_CHANNEL' ? '网络状况不佳，请稍后再试' : reason}` }
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

/** 打开 Releases 页面（只放行我们自己的几个域，别当通用 openURL 用） */
export function openReleasePage(url: string): void {
  const target = /^https:\/\/(github\.com|gh-proxy\.com|ghproxy\.net)\//.test(url) ? url : RELEASES_PAGE
  void shell.openExternal(target)
}
