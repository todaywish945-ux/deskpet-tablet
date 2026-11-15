import koffi from 'koffi'
import type { BrowserWindow } from 'electron'

// Electron 的 alwaysOnTop 只有"往上浮"的档位，没有永远垫底；
// 直接调 Win32 SetWindowPos 把窗口插到 Z 序最底（HWND_BOTTOM）。
const user32 = koffi.load('user32.dll')
const SetWindowPos = user32.func(
  'int __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32_t uFlags)'
)

const HWND_TOP = 0n
const HWND_BOTTOM = 1n
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010

/** 把窗口沉到所有普通窗口的最底下（仍在桌面图标之上），不抢焦点、不改位置尺寸 */
export function sendWindowToBottom(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
}

/** 把窗口硬抬到所有普通窗口之上（含全屏游戏这类大窗），不抢焦点、不改位置尺寸。
 *  唤回平板时 Electron 的 show/focus 激活可能被前台窗口悄悄拒绝，窗口留在 Z 序底
 *  被盖住；这层兜底保证"看得见"不依赖激活成败。 */
export function raiseWindowAboveNormal(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
}
