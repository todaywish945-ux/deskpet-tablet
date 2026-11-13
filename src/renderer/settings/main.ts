import type { AppConfig, TTSProvider, PetLayerMode } from '../../shared/types'

const api = window.settingsAPI

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const fields = {
  llmBase: $<HTMLInputElement>('llm-base'),
  llmKey: $<HTMLInputElement>('llm-key'),
  llmModel: $<HTMLInputElement>('llm-model'),
  winLayer: $<HTMLSelectElement>('win-layer'),
  skinSelect: $<HTMLSelectElement>('skin-select'),
  winIsland: $<HTMLInputElement>('win-island'),
  winIslandIdle: $<HTMLSelectElement>('win-island-idle'),
  proActive: $<HTMLInputElement>('pro-active'),
  appAutoStart: $<HTMLInputElement>('app-autostart'),
  callBargeIn: $<HTMLInputElement>('call-bargein'),
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
  fields.winLayer.value = data.window?.layer ?? 'bottom'
  void fillSkinOptions(data.character?.skin)
  fields.winIsland.checked = data.window?.island ?? true
  fields.winIslandIdle.value = String(data.window?.islandIdleSeconds ?? 10)
  fields.proActive.checked = data.proactive?.enabled ?? true
  fields.appAutoStart.checked = data.app?.autoStart ?? false
  fields.callBargeIn.checked = data.call?.bargeIn ?? true
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
      model: fields.llmModel.value.trim() || 'glm-5.3-flash'
    },
    character: {
      skin: fields.skinSelect.value
    },
    window: {
      layer: (fields.winLayer.value as PetLayerMode) || 'bottom',
      island: fields.winIsland.checked,
      islandIdleSeconds: Number(fields.winIslandIdle.value) || 10
    },
    proactive: {
      enabled: fields.proActive.checked
    },
    app: {
      autoStart: fields.appAutoStart.checked
    },
    call: {
      bargeIn: fields.callBargeIn.checked
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
    const { wav } = await api.testVoice('你好呀，我是桌宠。声音听起来还像吗？')
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

void (async () => {
  config = await api.getConfig()
  fillForm(config!)
})()
