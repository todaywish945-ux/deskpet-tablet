/**
 * 当前通话所在会话的共享状态。
 * 放在独立小模块里，避免 ipc ↔ proactive 互相 import 成环。
 */

let activeSessionId: string | null = null

export function getActiveSessionId(): string | null {
  return activeSessionId
}

export function setActiveSession(id: string | null): void {
  activeSessionId = id
}

/** 是否处于通话视图（渲染层 showView 时经 win:view-changed 上报，控制桥 /health 与 /call/* 用） */
let callActive = false

export function isCallActive(): boolean {
  return callActive
}

export function setCallActive(active: boolean): void {
  callActive = active
}
