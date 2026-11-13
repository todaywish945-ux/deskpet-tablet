/**
 * Live2D 渲染后端：pixi-live2d-display 实时驱动（video 后端 AnimationPlayer 的姊妹实现）。
 * 依赖 pet/index.html 里按顺序加载的 vendor 三件套（cubismcore → pixi → lipsyncpatch），
 * 模型经 petasset://skin/ 提供。行为映射：
 *   idle → model3.json 的 Idle 组自动循环 + 物理随动
 *   talk → 劫持 motionManager.update 在其后再写 ParamMouthOpenY（电平来自 PcmPlayer.level）
 *   emotion → skin.json emotions 表映射到 exp3 表情，8s 后复位
 *   cycleIdle/摸头 → 随机 Control 动作（FORCE 优先级打断）
 */
import type { SkinMeta } from '../../shared/types'

const EMOTION_HOLD_MS = 8000
/** 口型开合增益：RMS → ParamMouthOpenY(0..1) */
const MOUTH_GAIN = 1.6

interface PixiLive2DModel {
  width: number
  height: number
  x: number
  y: number
  interactive: boolean
  internalModel: {
    coreModel: { setParameterValueById?: (id: string, value: number, weight?: number) => void }
    motionManager: {
      update: (...args: unknown[]) => unknown
      expressionManager?: {
        resetExpression?: () => void
        restoreExpression?: () => void
      } | null
    }
  }
  expression(name?: string): void
  motion(group: string, index?: number, priority?: number): void
  startRandomMotion(group: string, priority?: number): void
}

export class Live2DPlayer {
  private container: HTMLElement
  private skin: SkinMeta
  private base: string

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private app: any = null
  private model: PixiLive2DModel | null = null
  private mode: 'loading' | 'ready' | 'failed' = 'loading'

  private talking = false
  private smoothedMouth = 0
  private levelSource: (() => number) | null = null
  private emotionTimer: ReturnType<typeof setTimeout> | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private currentEmotion = ''

  constructor(container: HTMLElement, skin: SkinMeta, base: string, levelSource: () => number) {
    this.container = container
    this.skin = skin
    this.base = base
    this.levelSource = levelSource
  }

  async init(): Promise<void> {
    // vendor UMD 全局，类型收紧意义不大，关键 API 在下方显式接口里
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PIXI = (window as unknown as { PIXI?: any }).PIXI
    if (!PIXI?.live2d) {
      this.fail('Live2D vendor 未加载（缺 pixi/cubismcore 脚本）')
      return
    }
    if (!this.skin.model) {
      this.fail('skin.json 缺 model 字段')
      return
    }
    try {
      const app = new PIXI.Application({
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        width: this.container.clientWidth || 600,
        height: this.container.clientHeight || 450
      })
      this.app = app
      this.container.innerHTML = ''
      this.container.appendChild((app as unknown as { view: HTMLCanvasElement }).view)

      const model = await PIXI.live2d.Live2DModel.from(`${this.base}/${this.skin.model}`)
      this.model = model
      // 等比缩放居中偏下，占满容器
      const cw = this.container.clientWidth || 600
      const ch = this.container.clientHeight || 450
      const scale = Math.min(cw / model.width, ch / model.height) * 0.95
      model.width = model.width * scale
      model.height = model.height * scale
      model.interactive = false
      app.stage.addChild(model)
      model.x = (cw - model.width) / 2
      model.y = ch - model.height

      this.hookMouth(model)
      this.mode = 'ready'
      console.log('[live2d] 模型就绪:', this.skin.model)
    } catch (error) {
      this.fail(`模型加载失败：${(error as Error).message}`)
    }
  }

  /** 劫持 motionManager.update：原逻辑跑完后再写嘴型，保证我们的值不被动作覆盖 */
  private hookMouth(model: PixiLive2DModel): void {
    try {
      const mm = model.internalModel.motionManager
      const orig = mm.update.bind(mm)
      const core = model.internalModel.coreModel
      mm.update = (...args: unknown[]) => {
        const result = orig(...args)
        if (this.talking) {
          const target = Math.min(1, (this.levelSource?.() ?? 0) * MOUTH_GAIN)
          this.smoothedMouth += (target - this.smoothedMouth) * 0.4
          core.setParameterValueById?.('ParamMouthOpenY', Math.max(this.smoothedMouth, 0.05), 1)
        } else {
          this.smoothedMouth *= 0.8
        }
        return result
      }
    } catch (error) {
      console.log('[live2d] 口型挂钩失败（不影响出声）:', (error as Error).message)
    }
  }

  private fail(msg: string): void {
    this.mode = 'failed'
    console.log('[live2d]', msg, '—— 显示皮肤头像占位')
    const img = document.createElement('img')
    img.src = `${this.base}/${this.skin.avatar}`
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain'
    this.container.innerHTML = ''
    this.container.appendChild(img)
  }

  /** 用户开口/闭口 */
  setTalking(talking: boolean): void {
    this.talking = talking
    if (!talking) this.smoothedMouth = 0
  }

  /** 合成期预载：Live2D 无需预载片段 */
  preloadTalk(): void {
    void this
  }

  /** 按音频剩余时间倒排收口（ms=0 立即收） */
  finishTalkingAt(ms: number): void {
    if (this.finishTimer) clearTimeout(this.finishTimer)
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null
      this.setTalking(false)
    }, Math.max(0, ms))
  }

  cancelFinishTimer(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
  }

  /** 情绪 → exp3 表情；空映射=清表情。8s 兜底复位 */
  setEmotion(name: string): void {
    if (this.mode !== 'ready' || !this.model) return
    this.currentEmotion = name
    if (this.emotionTimer) {
      clearTimeout(this.emotionTimer)
      this.emotionTimer = null
    }
    const expr = this.skin.emotions?.[name] ?? ''
    try {
      if (expr) this.model.expression(expr)
      else this.clearEmotion()
    } catch (error) {
      console.log(`[live2d] 表情 ${expr || '(none)'} 应用失败:`, (error as Error).message)
    }
    if (expr) {
      this.emotionTimer = setTimeout(() => {
        this.emotionTimer = null
        if (this.currentEmotion === name) {
          this.clearEmotion()
          this.currentEmotion = ''
        }
      }, EMOTION_HOLD_MS)
    }
  }

  private clearEmotion(): void {
    const em = this.model?.internalModel.motionManager.expressionManager
    try {
      em?.resetExpression?.() ?? em?.restoreExpression?.()
    } catch {
      // 部分版本没有复位接口：留着也无碍
    }
  }

  /** 点击切换：随机一个 Control 动作（FORCE 立即打断） */
  cycleIdle(): void {
    if (this.mode !== 'ready' || !this.model) return
    try {
      this.model.startRandomMotion('Control', 3)
    } catch (error) {
      console.log('[live2d] 动作切换失败:', (error as Error).message)
    }
  }

  /** 灵动岛收起冻结渲染（省 CPU/显存） */
  pauseAll(): void {
    this.app?.ticker.stop()
  }

  /** 唤回续播 */
  resumeAll(): void {
    this.app?.ticker.start()
  }

  /** 皮肤切换/销毁 */
  destroy(): void {
    this.cancelFinishTimer()
    if (this.emotionTimer) clearTimeout(this.emotionTimer)
    try {
      this.app?.destroy()
    } catch {
      // 重复销毁
    }
    this.app = null
    this.model = null
    this.mode = 'loading'
    this.container.innerHTML = ''
  }
}
