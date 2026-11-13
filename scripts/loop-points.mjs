// 为循环片段计算"首尾最相近帧"的最佳循环点，写入 loop-points.json
// 用法：node scripts/loop-points.mjs
// 原理：把片段抽成小尺寸灰度帧序列，在开头窗口和结尾窗口里穷举配对，
//       选帧差(MSE)最小的一对 (loopIn, loopOut)；播放器循环时在这两帧间跳转，肉眼无缝。
// 素材更换后重跑一次即可；只会重新生成 loop-points.json，不动视频文件本身。

import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const animDir = join(root, 'assets', 'animations')
const FPS = 15
const W = 160
const H = 120
const FRAME_BYTES = W * H
const START_WINDOW = Number(process.argv[3]) || 1.5 // 开头候选窗口（秒）
const END_WINDOW = Number(process.argv[4]) || 2.5 // 结尾候选窗口（秒）
const END_MARGIN = 0.25 // 结尾预留，避免顶到最后一帧
const MIN_LOOP = 1.2 // 最短循环长度（秒）

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('close', () => {
      const n = parseFloat(out.trim())
      isFinite(n) && n > 0 ? resolve(n) : reject(new Error(`无法读取时长: ${file}`))
    })
    p.on('error', reject)
  })
}

function extractFrames(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v', 'error',
      '-i', file,
      '-vf', `fps=${FPS},scale=${W}:${H},format=gray`,
      '-f', 'rawvideo',
      '-'
    ])
    const chunks = []
    p.stdout.on('data', (d) => chunks.push(d))
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`抽帧失败: ${file}`))
      const buf = Buffer.concat(chunks)
      const count = Math.floor(buf.length / FRAME_BYTES)
      const frames = []
      for (let i = 0; i < count; i++) frames.push(buf.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES))
      resolve(frames)
    })
    p.on('error', reject)
  })
}

function mse(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return sum / a.length
}

const manifest = JSON.parse(readFileSync(join(animDir, 'manifest.json'), 'utf-8'))
const idle = Array.isArray(manifest.idle) ? manifest.idle : manifest.idle ? [manifest.idle] : []
const talk = Array.isArray(manifest.talk) ? manifest.talk : manifest.talk ? [manifest.talk] : []
const allClips = [...new Set([...idle, ...talk])]
// 用法：node scripts/loop-points.mjs [片段名] [开头窗口s] [结尾窗口s]；缺省全量+默认窗口
const only = process.argv[2]
const clips = only ? allClips.filter((c) => c === only || c === only + '.mp4') : allClips
if (only && clips.length === 0) {
  console.error(`manifest 里没有片段: ${only}`)
  process.exit(1)
}

// 保留旧条目（openAt 归 find-talk-open.mjs 维护；循环点被新计算覆盖）
const out = {}
const prevLoop = existsSync(join(animDir, 'loop-points.json'))
  ? JSON.parse(readFileSync(join(animDir, 'loop-points.json'), 'utf-8'))
  : {}
for (const clip of allClips) {
  if (prevLoop[clip]) out[clip] = { ...prevLoop[clip] }
}
for (const clip of clips) {
  const file = join(animDir, clip)
  if (!existsSync(file)) {
    console.log(`跳过（不存在）: ${clip}`)
    continue
  }
  const duration = await probeDuration(file)
  const frames = await extractFrames(file)
  if (frames.length < FPS * (MIN_LOOP + 0.5)) {
    console.log(`跳过（太短）: ${clip}`)
    continue
  }

  const startCount = Math.min(frames.length, Math.ceil(START_WINDOW * FPS))
  const endFrom = Math.max(0, frames.length - Math.ceil(END_WINDOW * FPS))
  const endTo = Math.max(0, frames.length - Math.ceil(END_MARGIN * FPS))
  const minGapFrames = Math.ceil(MIN_LOOP * FPS)

  let best = null
  for (let s = 0; s < startCount; s++) {
    for (let e = Math.max(endFrom, s + minGapFrames); e < endTo; e++) {
      const score = mse(frames[s], frames[e])
      if (!best || score < best.score) best = { score, s, e }
    }
  }
  if (!best) {
    console.log(`跳过（找不到满足最短循环的配对）: ${clip}`)
    continue
  }
  const loopIn = +(best.s / FPS).toFixed(3)
  const loopOut = +(best.e / FPS).toFixed(3)
  out[clip] = { loopIn, loopOut }
  console.log(`${clip}: loopIn=${loopIn}s loopOut=${loopOut}s (循环 ${(loopOut - loopIn).toFixed(2)}s, 帧差 ${best.score.toFixed(1)})`)
}

writeFileSync(join(animDir, 'loop-points.json'), JSON.stringify(out, null, 2))
console.log(`\n已写入 loop-points.json（${Object.keys(out).length} 段）`)
