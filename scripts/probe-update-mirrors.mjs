// 探针 2：镜像矩阵——哪家现在能（a）取 latest 页版本号（b）流式下载 release 资产
const REPO = 'todaywish945-ux/deskpet-tablet'
const LATEST = `https://github.com/${REPO}/releases/latest`
const ASSET_RE = /qiaoqiao-setup-(\d+\.\d+\.\d+)\.exe/
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://gh.llkk.cc/', 'https://ghproxy.net/', 'https://mirror.ghproxy.com/', 'https://ghp.ci/']

async function fetchText(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

let assetUrl = null
for (const mirror of MIRRORS) {
  const label = mirror || '直连'
  try {
    const page = await fetchText(mirror + LATEST, 15000)
    const tag = /releases\/tag\/(v\d+\.\d+\.\d+)/.exec(page)?.[1]
    if (!tag) {
      console.log(`${label}  页面通但没版本号（len=${page.length}）`)
      continue
    }
    const list = await fetchText(`${mirror}https://github.com/${REPO}/releases/expanded_assets/${tag}`, 15000)
    const asset = ASSET_RE.exec(list)?.[0]
    if (!asset) {
      console.log(`${label}  tag=${tag} 但资产列表里没安装包`)
      continue
    }
    const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
    console.log(`${label}  ✓ tag=${tag} asset=${asset}`)
    if (!assetUrl) assetUrl = url
  } catch (e) {
    console.log(`${label}  FAIL ${String(e).slice(0, 90)}`)
  }
}

console.log('--- 资产下载流测试（前 2MB 掐断）---')
if (!assetUrl) {
  console.log('没有可用 URL')
} else {
  for (const mirror of MIRRORS) {
    const label = mirror || '直连'
    const controller = new AbortController()
    const started = Date.now()
    try {
      const r = await fetch(mirror + assetUrl, { redirect: 'follow', signal: controller.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.headers.get('content-type') ?? ''}`)
      let received = 0
      for await (const chunk of r.body) {
        received += chunk.length
        if (received >= 2 * 1024 * 1024) {
          controller.abort()
          break
        }
      }
      console.log(`${label}  ✓ ${received} 字节 / ${Date.now() - started}ms type=${r.headers.get('content-type')}`)
    } catch (e) {
      const aborted = String(e).toLowerCase().includes('abort')
      console.log(`${label}  ${aborted && received > 0 ? `✓（掐断于 ${received} 字节 / ${Date.now() - started}ms）` : `FAIL ${String(e).slice(0, 90)}`}`)
    }
  }
}
