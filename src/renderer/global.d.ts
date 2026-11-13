import type { AppConfig, ChatSession, SessionStore, UserProfile } from '../../shared/types'

declare global {
  interface Window {
    petAPI: {
      send: (text: string) => Promise<void>
      stop: () => Promise<void>
      openSettings: () => Promise<void>
      /** 可选角色皮肤列表（设置页下拉） */
      listSkins: () => Promise<{ id: string; name: string; backend: 'video' | 'live2d' }[]>
      hidePet: () => Promise<void>
      startDrag: (offsetX: number, offsetY: number) => void
      endDrag: () => void
      contextMenu: () => void
      /** 平板渲染层：闲置收起请求守卫通过后确认执行 */
      applyTabletHide: () => Promise<void>
      /** 灵动岛：展开卡片（主进程放大窗口后回 pet:island-mode） */
      expandCard: () => void
      /** 灵动岛：卡片收起动画播完，请主进程缩回胶囊 */
      collapseApply: () => Promise<void>
      /** 灵动岛：拖动胶囊 */
      startIslandDrag: (offsetX: number, offsetY: number) => void
      endIslandDrag: () => void
      /** 停靠细条：滑出 / 收回 */
      peekIsland: () => void
      retreatIsland: () => void
      /** 岛卡片按钮：唤回平板（focusChat=顺带聚焦输入框） */
      showTablet: (focusChat?: boolean) => Promise<void>
      pat: (zone: 'head' | 'body') => Promise<void>
      notifyView: (view: 'home' | 'call') => void
      listSessions: () => Promise<SessionStore>
      createSession: (topic: string) => Promise<ChatSession>
      openSession: (id: string) => Promise<ChatSession | null>
      deleteSession: (id: string) => Promise<SessionStore>
      beginCall: () => Promise<boolean>
      getProfile: () => Promise<UserProfile>
      deleteProfileFact: (factId: string) => Promise<UserProfile>
      on: (channel: string, callback: (...args: unknown[]) => void) => void
    }
    settingsAPI: {
      getConfig: () => Promise<AppConfig>
      saveConfig: (config: AppConfig) => Promise<boolean>
      enrollVoice: () => Promise<{ voiceId: string }>
      testVoice: (text: string) => Promise<{ wav: string }>
      pickRefAudio: () => Promise<{ path: string }>
      probeGsv: (apiBase: string) => Promise<{ online: boolean; status: number }>
      openPet: () => Promise<void>
      quit: () => Promise<void>
    }
  }
}

export {}
