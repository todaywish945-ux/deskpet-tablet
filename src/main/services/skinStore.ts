import { net } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, cpSync } from 'fs'
import { join } from 'path'
import type { SkinDownloadResult, SkinMeta, SkinPackageInfo } from '../../shared/types'
import { assetRoot, userSkinsRoot } from './store'
import { compareVersions, fetchLatestRelease, MIRROR, streamToFile, type ReleaseAsset } from './updater'

/** 角色包资产命名约定：skin-<皮肤id>-<版本>.zip（pack-skins.mjs 产出）+ 同名 .sha256 sidecar */
const SKIN_ASSET_RE = /skin-([a-z0-9-]+)-(\d+\.\d+\.\d+)\.zip/

/** tar.exe = Windows 自带 bsdtar，能直接解 zip（打包/解包同一工具，零新增依赖） */
function tarExe(): string {
  const candidate = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(candidate) ? candidate : 'tar'
}

function skinsRoot(): string {
  return userSkinsRoot()
}

function stagingRoot(): string {
  return join(userSkinsRoot(), '.staging')
}

function readSkinMeta(dir: string): SkinMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf-8')) as SkinMeta
  } catch {
    return null
  }
}

/** 本机已装版本：userData 优先，其次内置 resources；都没有 = null */
function installedSkinDir(id: string): string | null {
  for (const dir of [join(userSkinsRoot(), id), join(assetRoot(), 'skins', id)]) {
    if (existsSync(join(dir, 'skin.json'))) return dir
  }
  return null
}

function installedVersion(id: string): string | null {
  const dir = installedSkinDir(id)
  return dir ? readSkinMeta(dir)?.version ?? null : null
}

function installedName(id: string): string | null {
  const dir = installedSkinDir(id)
  return dir ? readSkinMeta(dir)?.name ?? null : null
}

/** 最新 Release 里的角色包（同名取最高版本），附带本机安装状态 */
export async function availableSkins(): Promise<{ ok: boolean; skins: SkinPackageInfo[]; viaMirror: boolean; error?: string }> {
  const release = await fetchLatestRelease()
  if (!release.ok || !release.info) return { ok: false, skins: [], viaMirror: false, error: release.error }
  const best = new Map<string, { version: string; url: string; size: number }>()
  for (const asset of release.info.assets) {
    const match = SKIN_ASSET_RE.exec(asset.name)
    if (!match) continue
    const prev = best.get(match[1])
    if (!prev || compareVersions(match[2], prev.version) > 0) best.set(match[1], { version: match[2], url: asset.url, size: asset.size })
  }
  const skins: SkinPackageInfo[] = [...best.entries()].map(([id, pkg]) => {
    const installed = installedVersion(id)
    return {
      id,
      version: pkg.version,
      downloadUrl: pkg.url,
      size: pkg.size,
      installedVersion: installed,
      installedName: installedName(id),
      hasUpdate: !installed || compareVersions(pkg.version, installed) > 0
    }
  })
  return { ok: true, skins, viaMirror: release.viaMirror }
}

// ---------- 下载与安装 ----------

let activeSkinDownload: AbortController | null = null
let skinCancelRequested = false

export function cancelSkinDownload(): void {
  skinCancelRequested = true
  activeSkinDownload?.abort()
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** sidecar 是 "<64位hex>  <文件名>" 一行文本；直连拿不到自动换镜像 */
async function fetchExpectedSha256(sidecarUrl: string): Promise<string | null> {
  for (const url of [sidecarUrl, MIRROR + sidecarUrl]) {
    try {
      const response = await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) continue
      const text = await response.text()
      const hex = /[a-fA-F0-9]{64}/.exec(text)?.[0]
      if (hex) return hex.toLowerCase()
    } catch {
      // 换下一路
    }
  }
  return null
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tarExe(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-500)
    })
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败（exit ${code}）${stderr ? '：' + stderr.trim() : ''}`))))
    child.once('error', (error) => reject(error))
  })
}

/** 把 version 写进已就位皮肤的 skin.json（老包没有该字段也能补） */
function patchSkinVersion(dir: string, version: string): void {
  const file = join(dir, 'skin.json')
  try {
    const meta = JSON.parse(readFileSync(file, 'utf-8')) as SkinMeta
    if (meta.version === version) return
    meta.version = version
    writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', 'utf-8')
  } catch {
    // 写不进去就先算了：installedVersion 会回落到 null，下次显示可"更新"
  }
}

/**
 * 下载角色包 → sha256 校验 → tar 解压 → 就位到 userData\skins\<id>。
 * 新角色立即生效；替换旧版时旧目录可能正被播放器占用，改为**暂存 + 重启时替换**
 * （processStagedSkinInstalls 在窗口创建前跑，那时绝无文件锁）。
 */
export async function downloadSkin(id: string, sender: import('electron').WebContents): Promise<SkinDownloadResult> {
  const avail = await availableSkins()
  const pkg = avail.skins.find((item) => item.id === id)
  if (!avail.ok || !pkg) return { ok: false, error: avail.error ?? '没有这个角色的下载包' }
  if (!pkg.hasUpdate) return { ok: false, error: '已安装同版本' }

  const staging = stagingRoot()
  mkdirSync(staging, { recursive: true })
  const zipPath = join(staging, `skin-${id}-${pkg.version}.zip`)
  const attempts = [
    { url: pkg.downloadUrl, viaMirror: false },
    { url: MIRROR + pkg.downloadUrl, viaMirror: true }
  ]
  let lastError: unknown = null
  for (const attempt of attempts) {
    const controller = new AbortController()
    activeSkinDownload = controller
    try {
      await streamToFile(attempt.url, zipPath, controller, (progress) => {
        if (!sender.isDestroyed()) sender.send('skin:progress', { id, received: progress.received, total: progress.total || pkg.size })
      })
      const expected = await fetchExpectedSha256(pkg.downloadUrl.replace(/\.zip$/, '.zip.sha256'))
      if (expected) {
        const actual = await sha256File(zipPath)
        if (actual !== expected) throw new Error('校验和不匹配（下载损坏），已自动换路重试')
      }
      const extractDir = join(staging, `${id}-${pkg.version}`)
      rmSync(extractDir, { recursive: true, force: true })
      mkdirSync(extractDir, { recursive: true })
      await runTar(['-xf', zipPath, '-C', extractDir])
      const extractedDir = join(extractDir, id)
      if (!existsSync(join(extractedDir, 'skin.json'))) throw new Error('解压后没找到 skin.json（包内容不对）')
      patchSkinVersion(extractedDir, pkg.version)

      const target = join(userSkinsRoot(), id)
      if (!existsSync(target)) {
        renameDir(join(extractDir, id), target)
        rmSync(extractDir, { recursive: true, force: true })
        cleanupStaging(staging, id)
        return { ok: true, applied: true, viaMirror: attempt.viaMirror }
      }
      // 旧版在位（可能正被播放器占用）：暂存，重启应用时替换
      return { ok: true, applied: false, pendingRestart: true, viaMirror: attempt.viaMirror }
    } catch (error) {
      lastError = error
      if (skinCancelRequested) {
        skinCancelRequested = false
        activeSkinDownload = null
        return { ok: false, error: '已取消下载' }
      }
    }
  }
  activeSkinDownload = null
  return { ok: false, error: `下载失败：${lastError instanceof Error ? lastError.message : '网络异常'}` }
}

/** userData 里同盘 rename 一般都能成；兜底走复制删除 */
function renameDir(from: string, to: string): void {
  try {
    rmSync(to, { recursive: true, force: true })
  } catch {
    // 目标不存在时忽略
  }
  try {
    renameSync(from, to)
  } catch {
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

function cleanupStaging(staging: string, id: string): void {
  try {
    for (const entry of readdirSync(staging, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(`skin-${id}-`)) {
        rmSync(join(staging, entry.name), { force: true })
      }
    }
  } catch {
    // 清理失败无伤大雅
  }
}

/**
 * 启动早期（窗口创建前）处理重启替换：此时绝无播放器文件锁。
 * staging 目录名 = <id>-<ver>；替换完连 staging 一起清掉。
 */
export function processStagedSkinInstalls(): void {
  const staging = stagingRoot()
  if (!existsSync(staging)) return
  try {
    for (const entry of readdirSync(staging, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const match = /^([a-z0-9-]+)-(\d+\.\d+\.\d+)$/.exec(entry.name)
      if (!match) continue
      const [, id, version] = match
      const extractedDir = join(staging, entry.name, id)
      if (!existsSync(join(extractedDir, 'skin.json'))) {
        rmSync(join(staging, entry.name), { recursive: true, force: true })
        continue
      }
      const target = join(userSkinsRoot(), id)
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 3 })
        renameDir(extractedDir, target)
        rmSync(join(staging, entry.name), { recursive: true, force: true })
      } catch {
        continue // 替换失败保留 staging，下次启动再试
      }
      cleanupStaging(staging, id)
    }
  } catch {
    // staging 扫描失败不阻塞启动
  }
}
