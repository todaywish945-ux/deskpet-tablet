/**
 * 宠物事件总线：渲染层 pet:* 事件的进程内分接点。
 * chatPipeline 等发送方调用 emitPetEvent，pluginBridge 订阅后转发给
 * 控制桥的 WebSocket 客户端（DSH 内嵌面板等远程视图）。
 * 独立小模块：chatPipeline 与 pluginBridge 互相 import 会成环，都只依赖这里。
 */

type PetEventListener = (channel: string, args: unknown[]) => void

const listeners = new Set<PetEventListener>()

export function onPetEvent(listener: PetEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitPetEvent(channel: string, args: unknown[]): void {
  for (const listener of listeners) listener(channel, args)
}
