import { useEffect, useRef, useState } from 'react'
import type { NetworkState } from './types'

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

export interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void
  onTouchMove: (e: React.TouchEvent) => void
  onTouchEnd: () => void
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onMouseLeave: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

/**
 * 长按手势：移动端没有 hover，就地菜单只能靠长按（scenario 手势规约要求显式声明）。
 * 同时接鼠标事件，便于在桌面浏览器 devtools 设备模拟下验证。
 *
 * consumeClick()：手指抬起后浏览器仍会补一次 click，长按已触发的行必须吞掉它，
 * 否则会「弹出 ActionSheet 的同时把文档打开」。
 */
export function useLongPress(onLongPress: () => void, enabled = true) {
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    origin.current = null
  }

  useEffect(() => clear, [])

  const start = (x: number, y: number) => {
    if (!enabled) return
    // 先清再记原点：clear() 会把 origin 置 null，反过来写等于每次滑动都因为没有
    // 原点可比而不取消，滚文稿滚到 500ms 就误弹长按菜单
    clear()
    origin.current = { x, y }
    timer.current = window.setTimeout(() => {
      timer.current = null
      origin.current = null
      fired.current = true
      onLongPress()
      window.setTimeout(() => { fired.current = false }, 400)
    }, LONG_PRESS_MS)
  }

  const move = (x: number, y: number) => {
    if (!origin.current) return
    const dx = Math.abs(x - origin.current.x)
    const dy = Math.abs(y - origin.current.y)
    if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) clear()
  }

  const handlers: LongPressHandlers = {
    onTouchStart: e => start(e.touches[0].clientX, e.touches[0].clientY),
    onTouchMove: e => move(e.touches[0].clientX, e.touches[0].clientY),
    onTouchEnd: clear,
    onMouseDown: e => start(e.clientX, e.clientY),
    onMouseMove: e => move(e.clientX, e.clientY),
    onMouseUp: clear,
    onMouseLeave: clear,
    // 长按会触发系统菜单/文本选择，必须吞掉
    onContextMenu: e => e.preventDefault(),
  }

  return { handlers, consumeClick: () => (fired.current ? true : false) }
}

/**
 * 软键盘避让：返回键盘占据的底部高度（px）。
 * iOS Safari 不会自动把 fixed 层顶起，Sheet 需自己按这个值上移。
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const read = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
    }
  }, [])

  return inset
}

/** 编译与真实排版依赖本机 TeX 服务，移动网络下必须显式区分在线/弱网/离线 */
export function useNetworkState(): NetworkState {
  const [state, setState] = useState<NetworkState>(() => readNetwork())

  useEffect(() => {
    const sync = () => setState(readNetwork())
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    const conn = networkInformation()
    conn?.addEventListener?.('change', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
      conn?.removeEventListener?.('change', sync)
    }
  }, [])

  return state
}

function networkInformation(): EventTarget | null {
  const nav = navigator as Navigator & { connection?: EventTarget }
  return nav.connection ?? null
}

function readNetwork(): NetworkState {
  if (!navigator.onLine) return 'offline'
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
  const type = conn?.effectiveType
  if (type === 'slow-2g' || type === '2g' || type === '3g') return 'slow'
  return 'online'
}
