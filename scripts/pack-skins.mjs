// 打角色包：node scripts/pack-skins.mjs <皮肤根目录> <输出目录>
// 每个非 hidden 皮肤 → skin-<id>-<version>.zip + 同名 .sha256 sidecar（应用内下载校验用）。
// 排除 voice/ 下的 GSV 权重（ckpt/pth，动辄 100MB+ 且属于语音整合包，不属于皮肤）；
// reference.wav 等皮肤自带的语音参考照常带上。
// zip 用 Windows 自带 bsdtar（System32\tar.exe -a 生成 zip），与应用内解压同一工具。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const skinsRoot = process.argv[2]
const outDir = process.argv[3]
if (!skinsRoot || !outDir) {
  console.error('用法：node scripts/pack-skins.mjs <皮肤根目录> <输出目录>')
  process.exit(1)
}
if (!fs.existsSync(skinsRoot)) {
  console.error(`皮肤根目录不存在：${skinsRoot}`)
  process.exit(1)
}

const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
if (!fs.existsSync(tarExe)) {
  console.error(`没找到 bsdtar：${tarExe}`)
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

for (const entry of fs.readdirSync(skinsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const skinJsonPath = path.join(skinsRoot, entry.name, 'skin.json')
  if (!fs.existsSync(skinJsonPath)) continue
  const meta = JSON.parse(fs.readFileSync(skinJsonPath, 'utf8'))
  if (meta.hidden) {
    console.log(`skip ${entry.name}（hidden 兜底壳，不打包）`)
    continue
  }
  if (!meta.version) {
    console.error(`FAIL ${entry.name}：skin.json 缺 version 字段（打包脚本不猜版本）`)
    process.exitCode = 1
    continue
  }
  const out = path.join(outDir, `skin-${entry.name}-${meta.version}.zip`)
  const args = [
    '-a', '-c', '-f', out,
    '--exclude', '*/voice/*.ckpt',
    '--exclude', '*/voice/*.pth',
    '-C', skinsRoot,
    entry.name
  ]
  execFileSync(tarExe, args, { stdio: 'pipe' })
  const hash = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')
  fs.writeFileSync(out + '.sha256', `${hash}  ${path.basename(out)}\n`)
  const sizeMb = (fs.statSync(out).size / 1024 / 1024).toFixed(1)
  console.log(`packed skin-${entry.name}-${meta.version}.zip  ${sizeMb}MB  sha256=${hash.slice(0, 16)}…`)
}
