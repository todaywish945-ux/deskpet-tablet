// E2E 探针：真实实例里验证设置页「软件更新」整条链路。
// 用法：node scripts/probe-update-e2e.mjs [应用根目录]（默认本仓库）
//   dev 版（0.1.0）→ 线上资产 0.1.1 → 会走「发现新版本 → 下载 → 取消」全链
//   克隆版（0.1.1）→ 资产 0.1.1 → 走「已是最新版本」分支
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const appRoot = path.resolve(process.argv[2] || path.resolve(fileURLToPath(import.meta.url), '..', '..'))
const electronExe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

async function freePorts(n) {
  const servers = []
  for (let i = 0; i < n; i++) {
    servers.push(
      await new Promise((resolve, reject) => {
        const server = net.createServer()
        server.listen(0, '127.0.0.1', () => resolve(server))
        server.on('error', reject)
      })
    )
  }
  const ports = servers.map((s) => s.address().port)
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  return ports
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 })
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send, ws, evalJs: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })).result?.result?.value }
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

const [debugPort, pluginPort] = await freePorts(2)
console.log(`launch ${appRoot} (cdp=${debugPort}, plugin=${pluginPort})`)
const child = spawn(electronExe, [appRoot], {
  cwd: appRoot,
  env: { ...process.env, PET_REMOTE_DEBUG: '1', PET_REMOTE_DEBUG_PORT: String(debugPort), PET_PLUGIN_PORT: String(pluginPort) }
})

try {
  // 等主 CDP 端口就绪并拿到平板渲染层
  let petTarget = null
  for (let i = 0; i < 60 && !petTarget; i++) {
    await sleep(1000)
    try {
      const targets = await listTargets(debugPort)
      petTarget = targets.find((t) => t.type === 'page' && /pet/.test(t.url))
    } catch {}
  }
  if (!petTarget) throw new Error('60s 内没等到平板渲染层 target')

  const pet = cdp(petTarget.webSocketDebuggerUrl)
  await new Promise((r) => pet.ws.once('open', r))
  const opened = await pet.evalJs('window.petAPI ? window.petAPI.openSettings() : "no-api"')
  console.log('openSettings ->', opened)

  // 等设置窗口出现
  let settingsTarget = null
  for (let i = 0; i < 20 && !settingsTarget; i++) {
    await sleep(1000)
    try {
      const targets = await listTargets(debugPort)
      settingsTarget = targets.find((t) => t.type === 'page' && /设置/.test(t.title))
    } catch {}
  }
  if (!settingsTarget) throw new Error('没等到设置窗口 target')

  const settings = cdp(settingsTarget.webSocketDebuggerUrl)
  await new Promise((r) => settings.ws.once('open', r))

  // 等「打开时的静默预检」落地（状态行非空）
  let observed = ''
  for (let i = 0; i < 25; i++) {
    await sleep(1000)
    observed = await settings.evalJs(
      `JSON.stringify({ cur: document.getElementById('update-current')?.textContent, status: document.getElementById('update-status')?.textContent, btn: document.getElementById('update-check-btn')?.textContent, mode: document.getElementById('update-check-btn')?.dataset.mode })`
    )
    const parsed = JSON.parse(observed)
    if (parsed.status) break
  }
  console.log('自动预检结果:', observed)

  // 触发下载（dev 版此时应为 download 模式）→ 观察进度 → 取消
  const clicked = await settings.evalJs(`(function(){ const b=document.getElementById('update-check-btn'); if (b && b.dataset.mode==='download') { b.click(); return 'clicked-download' } return 'skip:'+b?.dataset.mode })()`)
  console.log('下载触发:', clicked)
  if (clicked === 'clicked-download') {
    let progressSeen = ''
    for (let i = 0; i < 20; i++) {
      await sleep(1500)
      progressSeen = await settings.evalJs(`document.getElementById('update-progress-row').hidden + '|' + document.getElementById('update-progress-text')?.textContent`)
      console.log('进度采样', i, progressSeen)
      if (progressSeen.startsWith('false|') && /MB/.test(progressSeen)) break
    }
    await settings.evalJs(`document.getElementById('update-cancel-btn')?.click()`)
    for (let i = 0; i < 30; i++) {
      await sleep(1000)
      const status = await settings.evalJs(`document.getElementById('update-status')?.textContent`)
      if (status && /取消/.test(status)) {
        console.log('取消结果:', status)
        break
      }
    }
    // 恢复成检查态再截一张完整设置页
    await settings.evalJs(`document.getElementById('update-check-btn')?.click()`)
    await sleep(4000)
  }

  const shot = await settings.send('Page.captureScreenshot', { format: 'png' })
  await settings.evalJs(`document.getElementById('update-check-btn')?.scrollIntoView({ block: 'center' })`)
  await sleep(600)
  const shotUpdate = await settings.send('Page.captureScreenshot', { format: 'png' })
  const out = path.join(appRoot, 'preview-zzz', 'update-settings-e2e.png')
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, Buffer.from(shot.result.data, 'base64'))
  const outUpdate = path.join(appRoot, 'preview-zzz', 'update-settings-section.png')
  await fs.writeFile(outUpdate, Buffer.from(shotUpdate.result.data, 'base64'))
  console.log('截图:', out, outUpdate)
} catch (error) {
  console.error('E2E FAIL:', String(error))
  if (stderrTail) console.error('--- stderr 尾部 ---\n' + stderrTail)
  process.exitCode = 1
} finally {
  child.kill()
  await sleep(1500)
  process.exit(process.exitCode ?? 0)
}
