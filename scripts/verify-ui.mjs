// UI 冒烟：启动一个临时配置的真实实例，验证透明窗口 / 视频叠加层 / 圆角这组隐式约定。
// 这些约定页面截图看不出来（系统合成层在黑角/闪角里起作用），必须同时检查渲染页和桌面实拍。
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

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

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
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
  const ev = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text)
    }
    return res.result?.result?.value
  }
  return { ws, send, ev }
}

const req = `const M = process.getBuiltinModule('module'); const req = M.createRequire(process.cwd() + '/');`

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* 启动期连接失败/页面未就绪，继续等 */
    }
    await sleep(250)
  }
  throw new Error(`等待超时：${label}`)
}

const [renderPort, inspectPort] = await freePorts(2)
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knock-verify-'))
let child
const pet = { ws: null }

try {
  child = spawn(electronExe, [`--user-data-dir=${profileDir}`, '.', `--inspect=${inspectPort}`], {
    cwd: root,
    env: { ...process.env, PET_REMOTE_DEBUG: '1', PET_REMOTE_DEBUG_PORT: String(renderPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))

  const pages = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${renderPort}/json`)).json()
    return list.some((p) => p.url.includes('/pet/index.html')) && list.some((p) => p.url.includes('/island/index.html'))
      ? list
      : null
  }, 30_000, '渲染页启动')
  const petPage = pages.find((p) => p.url.includes('/pet/index.html'))
  const islandPage = pages.find((p) => p.url.includes('/island/index.html'))
  const petCdp = await cdp(petPage.webSocketDebuggerUrl)
  pet.ws = petCdp.ws
  const islandCdp = await cdp(islandPage.webSocketDebuggerUrl)

  // 沙箱默认配置 10 秒闲置收岛，自动化跑到一半窗口就藏了：先把收起时间拉长并唤回平板
  await petCdp.ev(`(async () => {
    const cfg = await window.settingsAPI.getConfig();
    cfg.window = cfg.window || {};
    cfg.window.islandIdleSeconds = 3600;
    cfg.window.layer = 'top';
    await window.settingsAPI.saveConfig(cfg);
    await window.petAPI.showTablet(false);
    return true;
  })()`)

  const mainWs = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json`)).json()
    return list[0]?.webSocketDebuggerUrl || null
  }, 15_000, '主进程调试端口')
  const main = await cdp(mainWs)

  const windows = await waitFor(async () => {
    const info = await main.ev(`(() => { ${req}
      const e = req('electron');
      const ws = e.BrowserWindow.getAllWindows();
      const pet = ws.find((w) => w.getTitle() === '敲敲');
      const island = ws.find((w) => w.getTitle() === '灵动岛');
      if (!pet || !island) return null;
      return {
        flag: e.app.commandLine.hasSwitch('disable-direct-composition-video-overlays'),
        scale: e.screen.getPrimaryDisplay().scaleFactor
      };
    })()`)
    return info
  }, 20_000, '窗口与皮肤加载')

  check('系统视频叠加层已禁用', windows.flag === true, `hasSwitch=${windows.flag}`)

  // getZoomFactor 在部分实例里会返回 1（实际缩放已生效），用渲染页的 devicePixelRatio / 系统缩放率测真实值。
  // 缩放钉在 did-finish-load 才生效，可能晚于窗口出现，轮询等它稳定
  const settledDpr = await waitFor(async () => {
    const dpr = await petCdp.ev('devicePixelRatio')
    return dpr > windows.scale * 1.05 ? dpr : null
  }, 6000, '平板缩放钉住').catch(() => null)
  const petDpr = settledDpr ?? (await petCdp.ev('devicePixelRatio'))
  const islandDpr = await islandCdp.ev('devicePixelRatio')
  const petZoom = petDpr / windows.scale
  const islandZoom = islandDpr / windows.scale
  check('平板缩放固定 1.1465', Math.abs(petZoom - 720 / 628) < 0.01, `dpr=${petDpr} 实际=${petZoom.toFixed(4)}`)
  check('灵动岛缩放固定 1', Math.abs(islandZoom - 1) < 0.001, `dpr=${islandDpr} 实际=${islandZoom.toFixed(4)}`)

  const css = await waitFor(async () => {
    const info = await petCdp.ev(`(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const screen = document.getElementById('screen');
      const layer = document.getElementById('char-layer');
      const video = layer ? layer.querySelector('video') : null;
      if (!screen || !layer || !video) return null;
      return {
        radiusVar: rootStyle.getPropertyValue('--screen-radius').trim(),
        screenRadius: getComputedStyle(screen).borderRadius,
        layerRadius: getComputedStyle(layer).borderRadius,
        layerOverflow: getComputedStyle(layer).overflow,
        videoRadius: getComputedStyle(video).borderRadius,
        videoCount: layer.querySelectorAll('video').length
      };
    })()`)
    return info
  }, 20_000, '皮肤视频加载')

  check('圆角变量存在', css.radiusVar === '34px', `--screen-radius=${css.radiusVar}`)
  check('屏幕引用圆角变量', css.screenRadius.startsWith('34px'), `#screen=${css.screenRadius}`)
  check(
    '动画层圆角裁剪',
    css.layerRadius.startsWith('34px') && css.layerOverflow === 'hidden',
    `border-radius=${css.layerRadius} overflow=${css.layerOverflow}`
  )
  check('视频像素自带圆角', css.videoRadius.startsWith('34px'), `video=${css.videoRadius}，共 ${css.videoCount} 层`)
  check('岛页面可访问', (await islandCdp.ev('document.title')) === '灵动岛', '')
  const islandAvatars = await waitFor(async () => {
    const imgs = await islandCdp.ev(`(() => [...document.querySelectorAll('.strip-avatar, .avatar img, .card-avatar')].map((i) => i.currentSrc || i.src || ''))()`)
    return Array.isArray(imgs) && imgs.length === 3 && imgs.every((s) => s.includes('avatar.png')) ? imgs : null
  }, 8000, '灵动岛头像').catch(() => null)
  check('灵动岛头像跟随角色', islandAvatars !== null, islandAvatars ? `count=${islandAvatars.length}` : '仍是默认图标')

  async function captureCorners(label) {
    await petCdp.ev('window.petAPI.showTablet(false)')
    await sleep(400)
    const alpha = await waitFor(async () => {
      const info = await main.ev(`(async () => { ${req}
        const e = req('electron');
        const pet = e.BrowserWindow.getAllWindows().find((w) => w.getTitle() === '敲敲');
        const img = await pet.webContents.capturePage();
        const { width, height } = img.getSize();
        const bmp = img.toBitmap();
        const alphaAt = (x, y) => bmp[(y * width + x) * 4 + 3];
        const corners = [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3]].map(([x, y]) => alphaAt(x, y));
        return { width, height, corners, center: alphaAt(width >> 1, height >> 1) };
      })()`)
      return info && info.width > 0 ? info : null
    }, 5000, '页面截图').catch(() => null)
    if (!alpha) {
      check(`${label}：四角透明`, false, '窗口不可见，截图为空')
      return
    }
    const cornersTransparent = alpha.corners.every((a) => a === 0)
    const centerOpaque = alpha.center > 0
    check(`${label}：四角透明`, cornersTransparent && centerOpaque, `corners=${alpha.corners.join(',')} center=${alpha.center}`)
  }

  await captureCorners('主界面')

  await petCdp.ev(`document.getElementById('tab-video').click()`)
  await sleep(400)
  await petCdp.ev(`document.getElementById('invite-btn').click()`)
  await sleep(2500)
  const callVisible = await petCdp.ev(`!document.getElementById('call-view').classList.contains('hidden')`)
  check('视频通话界面能打开', callVisible === true)
  const videoLive = await petCdp.ev(`(() => {
    const vs = [...document.querySelectorAll('#char-layer video')];
    return {
      count: vs.length,
      visible: vs.filter((v) => Number(v.style.opacity || '0') > 0.5 && !v.paused && v.readyState >= 2 && v.videoWidth > 0).length,
      detail: vs.map((v) => ({ src: (v.currentSrc || '').split('/').pop(), op: v.style.opacity, paused: v.paused, ready: v.readyState, w: v.videoWidth }))
    };
  })()`)
  check('人物视频正在渲染', videoLive.count >= 2 && videoLive.visible >= 1, `videos=${videoLive.count} visible=${videoLive.visible} ${JSON.stringify(videoLive.detail)}`)
  if (callVisible) await captureCorners('通话界面')

  // 系统合成层实拍：先把底层桌面拍一张，再让桌宠置顶拍一张。
  // 正常情况四角像素应与底图一致（窗口圆角外是透明的），中心区域必须有明显变化（窗口确实在上面）。
  await petCdp.ev('window.petAPI.showTablet(false)')
  await sleep(500)

  const osCheck = await main.ev(`(async () => { ${req}
    const e = req('electron');
    const pet = e.BrowserWindow.getAllWindows().find((w) => w.getTitle() === '敲敲');
    const d = e.screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const grab = async () => {
      for (let i = 0; i < 4; i++) {
        const sources = await e.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
        const png = sources[0]?.thumbnail?.toPNG();
        if (png && png.length) return e.nativeImage.createFromBuffer(png);
        await new Promise((r) => setTimeout(r, 400));
      }
      return e.nativeImage.createEmpty();
    };
    const avg = (bmp, w, h, x, y) => {
      let sum = [0, 0, 0], n = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const o = (yy * w + xx) * 4;
        sum[0] += bmp[o]; sum[1] += bmp[o + 1]; sum[2] += bmp[o + 2]; n++;
      }
      return sum.map((v) => v / n);
    };
    const pointDiff = (a, aw, ah, b, bw2, bh2, x, y) => {
      const pa = avg(a, aw, ah, x, y), pb = avg(b, bw2, bh2, x, y);
      return Math.round(Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]));
    };

    const r = pet.getBounds(), sf = d.scaleFactor;
    const px = Math.round(r.x * sf), py = Math.round(r.y * sf);
    const pw = Math.round(r.width * sf), ph = Math.round(r.height * sf);
    const cx = px + Math.round(pw / 2), cy = py + Math.round(ph / 2);

    pet.hide();
    await new Promise((r) => setTimeout(r, 600));
    const base = await grab();
    // 显示后桌面合成可能慢半拍：以“中心区域和隐藏时不同”为准重试几次
    pet.showInactive();
    pet.setAlwaysOnTop(true, 'screen-saver');
    let shot = e.nativeImage.createEmpty();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 500));
      shot = await grab();
      if (shot.getSize().width === 0) continue;
      const diff = pointDiff(
        base.toBitmap(), base.getSize().width, base.getSize().height,
        shot.toBitmap(), shot.getSize().width, shot.getSize().height,
        cx, cy
      );
      if (diff > 30) break;
    }
    pet.hide();
    await new Promise((r) => setTimeout(r, 600));
    const after = await grab();
    if (base.getSize().width === 0 || shot.getSize().width === 0 || after.getSize().width === 0) return { empty: true };
    const saveDir = ${JSON.stringify(process.env.KNOCK_VERIFY_SAVE ? path.join(root, 'preview-zzz') : '')};
    if (saveDir) {
      req('fs').writeFileSync(saveDir + '/verify-os-base.png', base.toPNG());
      req('fs').writeFileSync(saveDir + '/verify-os-shot.png', shot.toPNG());
      req('fs').writeFileSync(saveDir + '/verify-os-after.png', after.toPNG());
    }

    const images = [base, after];
    const bmps = images.map((img) => ({ bmp: img.toBitmap(), w: img.getSize().width, h: img.getSize().height }));
    const sw = shot.getSize().width, sh = shot.getSize().height;
    const bmpS = shot.toBitmap();
    // 和显示前、隐藏后两张底图都比：只有两边都不同才算桌宠画面漏到了这里，
    // 桌面自身在两次截图间变化（视频/壁纸）不会误报
    const diffPair = (x, y) => {
      return bmps.map(({ bmp, w, h }) => pointDiff(bmp, w, h, bmpS, sw, sh, x, y));
    };
    // 同一张实拍里：圆角外的角点必须和窗口外侧紧邻的桌面像素一致。
    // 真实漏画面时角上会是人物/视频，和旁边桌面差异很大；桌面自己变化不会影响这个判断
    const sameDiff = (x1, y1, x2, y2) => {
      const a = avg(bmpS, sw, sh, x1, y1)
      const b = avg(bmpS, sw, sh, x2, y2)
      return Math.round(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]))
    };
    const outside = {
      tl: sameDiff(px + 4, py + 4, Math.max(2, px - 8), py + 4),
      tr: sameDiff(px + pw - 4, py + 4, Math.min(sw - 3, px + pw + 8), py + 4),
      bl: sameDiff(px + 4, py + ph - 4, Math.max(2, px - 8), py + ph - 4),
      br: sameDiff(px + pw - 4, py + ph - 4, Math.min(sw - 3, px + pw + 8), py + ph - 4)
    };
    return {
      corners: {
        tl: diffPair(px + 4, py + 4),
        tr: diffPair(px + pw - 4, py + 4),
        bl: diffPair(px + 4, py + ph - 4),
        br: diffPair(px + pw - 4, py + ph - 4)
      },
      outside,
      center: diffPair(px + Math.round(pw / 2), py + Math.round(ph / 2)),
      bounds: { px, py, pw, ph }, capture: { bw: sw, bh: sh }
    };
  })()`)

  if (osCheck.empty) {
    console.log('SKIP  桌面实拍 — 屏幕截图不可用（锁屏/息屏/远程桌面），醒来后重跑')
  } else {
    const leaking = Object.keys(osCheck.outside).filter(
      (key) => osCheck.outside[key] > 60 && Math.min(...osCheck.corners[key]) > 30
    )
    check('桌面实拍：圆角外无画面泄漏', leaking.length === 0, `角内/角外=${JSON.stringify(osCheck.outside)} 底图差=${JSON.stringify(osCheck.corners)}`)
    const centerMin = Math.min(...osCheck.center)
    check('桌面实拍：桌宠确实置顶显示', centerMin > 30, `中心差异=${osCheck.center} bounds=${JSON.stringify(osCheck.bounds)} capture=${osCheck.capture.bw}x${osCheck.capture.bh}`)
  }
} finally {
  try {
    pet.ws?.close()
  } catch {
    /* 忽略 */
  }
  if (child && child.pid) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve())
    })
  }
  await sleep(800)
  // 进程刚被杀时 lockfile 可能还占着：多试几次，清不掉就留给系统临时目录
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rm(profileDir, { recursive: true, force: true })
      break
    } catch {
      await sleep(500)
    }
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}：${results.filter((r) => r.ok).length}/${results.length}`)
process.exit(failed.length === 0 ? 0 : 1)
