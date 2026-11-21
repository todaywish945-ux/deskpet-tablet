import type { AppConfig, TTSProvider, PetLayerMode } from '../../shared/types'

const api = window.settingsAPI

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const fields = {
  llmBase: $<HTMLInputElement>('llm-base'),
  llmKey: $<HTMLInputElement>('llm-key'),
  llmModel: $<HTMLInputElement>('llm-model'),
  llmBackupBase: $<HTMLInputElement>('llm-backup-base'),
  llmBackupKey: $<HTMLInputElement>('llm-backup-key'),
  llmBackupModel: $<HTMLInputElement>('llm-backup-model'),
  winLayer: $<HTMLSelectElement>('win-layer'),
  skinSelect: $<HTMLSelectElement>('skin-select'),
  winIsland: $<HTMLInputElement>('win-island'),
  winIslandIdle: $<HTMLSelectElement>('win-island-idle'),
  proActive: $<HTMLInputElement>('pro-active'),
  proHealth: $<HTMLInputElement>('pro-health'),
  appAutoStart: $<HTMLInputElement>('app-autostart'),
  ttsEnabled: $<HTMLInputElement>('tts-enabled'),
  ttsProvider: $<HTMLSelectElement>('tts-provider'),
  bailianBlock: $<HTMLDivElement>('bailian-block'),
  gptsovitsBlock: $<HTMLDivElement>('gptsovits-block'),
  ttsKey: $<HTMLInputElement>('tts-key'),
  ttsModel: $<HTMLSelectElement>('tts-model'),
  ttsVoice: $<HTMLInputElement>('tts-voice'),
  gsvApiBase: $<HTMLInputElement>('gsv-api-base'),
  gsvRefAudio: $<HTMLInputElement>('gsv-ref-audio'),
  gsvRefText: $<HTMLTextAreaElement>('gsv-ref-text'),
  ttsSpeed: $<HTMLInputElement>('tts-speed'),
  ttsVolume: $<HTMLInputElement>('tts-volume')
}

const status = $<HTMLSpanElement>('status')
const saveBtn = $<HTMLButtonElement>('save-btn')
const enrollBtn = $<HTMLButtonElement>('enroll-btn')
const testBtn = $<HTMLButtonElement>('test-btn')
const pickBtn = $<HTMLButtonElement>('gsv-pick-btn')
const probeBtn = $<HTMLButtonElement>('gsv-probe-btn')
const gsvStatus = $<HTMLSpanElement>('gsv-status')

let config: AppConfig | null = null

/** 皮肤下拉：内置+用户自装合并列表；没有可选时塞当前值占位 */
async function fillSkinOptions(active?: string): Promise<void> {
  try {
    const skins = await window.petAPI.listSkins()
    fields.skinSelect.innerHTML = ''
    for (const s of skins) {
      const opt = document.createElement('option')
      opt.value = s.id
      opt.textContent = s.name + (s.backend === 'live2d' ? '（Live2D）' : '')
      fields.skinSelect.appendChild(opt)
    }
    fields.skinSelect.value = active && skins.some((s) => s.id === active) ? active : (skins[0]?.id ?? '')
  } catch {
    // 列表拿不到就留空
  }
}

function setStatus(text: string, isError = false): void {
  status.textContent = text
  status.classList.toggle('err', isError)
}

function switchProvider(provider: TTSProvider): void {
  fields.bailianBlock.hidden = provider !== 'bailian'
  fields.gptsovitsBlock.hidden = provider !== 'gptsovits'
}

function fillForm(data: AppConfig): void {
  fields.llmBase.value = data.llm.baseUrl
  fields.llmKey.value = data.llm.apiKey
  fields.llmModel.value = data.llm.model
  fields.llmBackupBase.value = data.llm.backup?.baseUrl ?? ''
  fields.llmBackupKey.value = data.llm.backup?.apiKey ?? ''
  fields.llmBackupModel.value = data.llm.backup?.model ?? ''
  fields.winLayer.value = data.window?.layer ?? 'bottom'
  void fillSkinOptions(data.character?.skin)
  fields.winIsland.checked = data.window?.island ?? true
  fields.winIslandIdle.value = String(data.window?.islandIdleSeconds ?? 10)
  fields.proActive.checked = data.proactive?.enabled ?? true
  fields.proHealth.checked = data.proactive?.health ?? true
  fields.appAutoStart.checked = data.app?.autoStart ?? false
  fields.ttsEnabled.checked = data.tts.enabled
  fields.ttsProvider.value = data.tts.provider ?? 'bailian'
  switchProvider(data.tts.provider ?? 'bailian')
  fields.ttsKey.value = data.tts.apiKey
  fields.ttsModel.value = data.tts.model
  fields.ttsVoice.value = data.tts.voice
  fields.gsvApiBase.value = data.tts.gsvApiBase || 'http://127.0.0.1:9880'
  fields.gsvRefAudio.value = data.tts.gsvRefAudio
  fields.gsvRefText.value = data.tts.gsvRefText
  fields.ttsSpeed.value = String(data.tts.speed)
  fields.ttsVolume.value = String(data.tts.volume)
}

function collectConfig(): AppConfig {
  if (!config) throw new Error('配置未加载')
  return {
    llm: {
      baseUrl: fields.llmBase.value.trim() || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: fields.llmKey.value.trim(),
      model: fields.llmModel.value.trim() || 'glm-5.3-flash',
      backup: {
        baseUrl: fields.llmBackupBase.value.trim(),
        apiKey: fields.llmBackupKey.value.trim(),
        model: fields.llmBackupModel.value.trim()
      }
    },
    character: {
      skin: fields.skinSelect.value,
      // 邀约卡星标在平板里点亮/熄灭：设置页保存时原样保留
      favorite: config.character.favorite ?? false
    },
    window: {
      layer: (fields.winLayer.value as PetLayerMode) || 'bottom',
      island: fields.winIsland.checked,
      islandIdleSeconds: Number(fields.winIslandIdle.value) || 10
    },
    proactive: {
      enabled: fields.proActive.checked,
      health: fields.proHealth.checked
    },
    app: {
      autoStart: fields.appAutoStart.checked
    },
    tts: {
      enabled: fields.ttsEnabled.checked,
      provider: (fields.ttsProvider.value as TTSProvider) || 'bailian',
      apiKey: fields.ttsKey.value.trim(),
      model: fields.ttsModel.value,
      voice: fields.ttsVoice.value.trim(),
      speed: clamp(Number(fields.ttsSpeed.value) || 1, 0.5, 2),
      volume: clamp(Number(fields.ttsVolume.value) || 1, 0, 1),
      gsvApiBase: fields.gsvApiBase.value.trim() || 'http://127.0.0.1:9880',
      gsvRefAudio: fields.gsvRefAudio.value.trim(),
      gsvRefText: fields.gsvRefText.value.trim(),
      gsvPromptLang: config.tts.gsvPromptLang || 'zh',
      gsvTextLang: config.tts.gsvTextLang || 'zh'
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// 注意：改语音模型后，旧音色 ID 不再匹配，需要清掉重新注册
fields.ttsModel.addEventListener('change', () => {
  fields.ttsVoice.value = ''
  setStatus('语音模型已切换，请重新注册克隆音色', true)
})

fields.ttsProvider.addEventListener('change', () => {
  switchProvider(fields.ttsProvider.value as TTSProvider)
})

enrollBtn.addEventListener('click', async () => {
  setStatus('')
  // 注册前先把当前表单（含 Key 和模型）存下来
  try {
    config = collectConfig()
    await api.saveConfig(config)
  } catch (error) {
    setStatus(String((error as Error).message), true)
    return
  }
  enrollBtn.disabled = true
  enrollBtn.textContent = '注册中…'
  try {
    const { voiceId } = await api.enrollVoice()
    fields.ttsVoice.value = voiceId
    setStatus(`音色注册成功：${voiceId}`)
  } catch (error) {
    setStatus(`注册失败：${(error as Error).message}`, true)
  } finally {
    enrollBtn.disabled = false
    enrollBtn.textContent = '① 用参考音频注册克隆音色'
  }
})

testBtn.addEventListener('click', async () => {
  setStatus('')
  testBtn.disabled = true
  testBtn.textContent = '合成中…'
  try {
    config = collectConfig()
    await api.saveConfig(config)
    const { wav } = await api.testVoice('你好呀，我是叶瞬光。声音听起来还像吗？')
    const audio = new Audio(`data:audio/wav;base64,${wav}`)
    void audio.play()
    setStatus('试听播放中…')
  } catch (error) {
    setStatus(`试听失败：${(error as Error).message}`, true)
  } finally {
    testBtn.disabled = false
    testBtn.textContent = '② 试听'
  }
})

pickBtn.addEventListener('click', async () => {
  const { path } = await api.pickRefAudio()
  if (path) fields.gsvRefAudio.value = path
})

probeBtn.addEventListener('click', async () => {
  gsvStatus.textContent = '检测中…'
  gsvStatus.classList.remove('err')
  try {
    const { online, status: code } = await api.probeGsv(fields.gsvApiBase.value.trim())
    if (online) {
      gsvStatus.textContent = '本地语音服务在线 ✓'
    } else {
      gsvStatus.classList.add('err')
      gsvStatus.textContent = code ? `服务异常（HTTP ${code}）` : '没连上：先启动整合包里的启动脚本'
    }
  } catch (error) {
    gsvStatus.classList.add('err')
    gsvStatus.textContent = `检测失败：${(error as Error).message}`
  }
})

saveBtn.addEventListener('click', async () => {
  try {
    config = collectConfig()
    await api.saveConfig(config)
    setStatus('已保存 ✓')
  } catch (error) {
    setStatus(`保存失败：${(error as Error).message}`, true)
  }
})

// ---------- 软件更新 ----------

const updateCurrent = $<HTMLSpanElement>('update-current')
const updateCheckBtn = $<HTMLButtonElement>('update-check-btn')
const updateOpenBtn = $<HTMLButtonElement>('update-open-btn')
const updateProgressRow = $<HTMLDivElement>('update-progress-row')
const updateProgress = $<HTMLProgressElement>('update-progress')
const updateProgressText = $<HTMLSpanElement>('update-progress-text')
const updateCancelBtn = $<HTMLButtonElement>('update-cancel-btn')
const updateInstallRow = $<HTMLDivElement>('update-install-row')
const updateInstallBtn = $<HTMLButtonElement>('update-install-btn')
const updateStatus = $<HTMLParagraphElement>('update-status')

let lastReleaseUrl = ''

function setUpdateStatus(text: string, isError = false): void {
  updateStatus.textContent = text
  updateStatus.classList.toggle('err', isError)
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

api.onUpdateProgress(({ received, total }) => {
  if (total > 0) {
    const percent = Math.min(100, Math.round((received / total) * 100))
    updateProgress.value = percent
    updateProgressText.textContent = `${mb(received)} / ${mb(total)} MB（${percent}%）`
  } else {
    updateProgressText.textContent = `已下载 ${mb(received)} MB…`
  }
})

/** notifyOnError=false 用于设置页打开时的静默预检（失败不打扰） */
async function runUpdateCheck(notifyOnError: boolean): Promise<void> {
  try {
    const info = await api.checkUpdate()
    updateCurrent.textContent = `v${info.currentVersion}`
    lastReleaseUrl = info.releaseUrl
    updateOpenBtn.hidden = false
    if (!info.ok) {
      if (notifyOnError) setUpdateStatus(`检查失败：${info.error ?? '连不上 GitHub'}。可以点「打开下载页」手动看看。`, true)
      return
    }
    if (info.hasUpdate && info.downloadUrl) {
      setUpdateStatus(`发现新版本 v${info.version}（当前 v${info.currentVersion}），点「下载更新」开始下载${info.viaMirror ? '（经镜像）' : ''}`)
      updateCheckBtn.textContent = '下载更新'
      updateCheckBtn.dataset.mode = 'download'
    } else if (info.version) {
      setUpdateStatus(`已是最新版本（v${info.currentVersion}）`)
    } else {
      setUpdateStatus('最新发布里没有认出安装包，请到下载页手动查看', true)
    }
  } catch (error) {
    if (notifyOnError) setUpdateStatus(`检查失败：${(error as Error).message}`, true)
  }
}

updateCheckBtn.addEventListener('click', async () => {
  if (updateCheckBtn.dataset.mode === 'download') {
    updateCheckBtn.disabled = true
    updateProgressRow.hidden = false
    updateProgress.value = 0
    updateProgressText.textContent = '连接中…'
    try {
      const result = await api.downloadUpdate()
      updateProgressRow.hidden = true
      if (result.ok) {
        updateInstallRow.hidden = false
        setUpdateStatus(`下载完成 ✓ 点「立即安装并重启」升级${result.viaMirror ? '（经镜像）' : ''}`)
      } else if (result.error === '已取消下载') {
        setUpdateStatus('已取消下载')
      } else {
        setUpdateStatus(`下载失败：${result.error ?? ''}。可重试，或点「打开下载页」手动下载。`, true)
      }
      updateCheckBtn.dataset.mode = 'check'
      updateCheckBtn.textContent = '重新检查'
    } catch (error) {
      updateProgressRow.hidden = true
      setUpdateStatus(`下载失败：${(error as Error).message}`, true)
      updateCheckBtn.dataset.mode = 'check'
      updateCheckBtn.textContent = '重新检查'
    } finally {
      updateCheckBtn.disabled = false
    }
    return
  }
  updateCheckBtn.disabled = true
  updateCheckBtn.textContent = '检查中…'
  await runUpdateCheck(true)
  updateCheckBtn.disabled = false
  if (updateCheckBtn.textContent === '检查中…') updateCheckBtn.textContent = '检查更新'
})

updateCancelBtn.addEventListener('click', () => {
  void api.cancelUpdateDownload()
})

updateInstallBtn.addEventListener('click', async () => {
  updateInstallBtn.disabled = true
  updateInstallBtn.textContent = '正在启动安装器…'
  try {
    const result = await api.installUpdate()
    if (!result.ok) {
      setUpdateStatus(`启动失败：${result.error ?? ''}`, true)
      updateInstallBtn.disabled = false
      updateInstallBtn.textContent = '立即安装并重启'
    }
    // 成功时主进程会 app.quit()，页面随窗口一起关闭
  } catch (error) {
    setUpdateStatus(`启动失败：${(error as Error).message}`, true)
    updateInstallBtn.disabled = false
    updateInstallBtn.textContent = '立即安装并重启'
  }
})

updateOpenBtn.addEventListener('click', () => {
  void api.openReleasePage(lastReleaseUrl)
})

void (async () => {
  config = await api.getConfig()
  fillForm(config!)
  void api.getVersion().then((version) => {
    updateCurrent.textContent = `v${version}`
  })
  void runUpdateCheck(false) // 打开设置页时静默预检一次，失败不打扰
})()
