// 设备识别：这台设备是什么、接了什么外设、眼下在用什么输入。和窗口宽度、缩放无关（宽度只管布局，见 desktop.svelte.ts）。
//   kind      phone / tablet / desktop：按系统报的设备类型认。iPad 的 Safari 默认报成 Mac，靠多点触控认出来
//   mouse     有鼠标或触控板（含 iPhone / iPad 外接的鼠标、触控板）：any-pointer: fine，插拔时跟着变
//   keyboard  有实体键盘：电脑默认有；手机 / 平板上，在没有输入框获得焦点时收到按键（只有外接键盘会这样）就算有
//   pointer   最近一次指针操作是 mouse / touch / pen：触屏笔记本、接了鼠标的 iPad 两种都有，每一下按当下这一下处理
type Kind = 'phone' | 'tablet' | 'desktop'
type Pointer = 'mouse' | 'touch' | 'pen' | ''

const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } })
const ua = nav?.userAgent || ''
const touchPoints = nav?.maxTouchPoints || 0

function detectKind(): Kind {
  if (nav?.userAgentData?.mobile) return 'phone'
  if (/iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua)) return 'phone'
  if (/iPad|Android|Tablet/i.test(ua)) return 'tablet'
  if (/Macintosh/i.test(ua) && touchPoints > 1) return 'tablet' // iPadOS 的「桌面版网站」：UA 和 Mac 一样，但 Mac 没有触屏
  return 'desktop'
}
const media = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q) : null)
const fineQ = media('(any-pointer: fine)')

const kind = detectKind()
export const device = $state({
  kind,
  touch: touchPoints > 0,
  mouse: !!fineQ?.matches,
  keyboard: kind === 'desktop',
  pointer: '' as Pointer,
})

fineQ?.addEventListener('change', () => { device.mouse = !!fineQ.matches })

if (typeof window !== 'undefined') {
  // 捕获阶段先记下这一下是什么指针（pointerdown 在 mousedown / touchstart 之前到）
  const note = (e: PointerEvent) => {
    const p = (e.pointerType || '') as Pointer
    if (p && p !== device.pointer) device.pointer = p
    if (p === 'mouse' && !device.mouse) device.mouse = true // 有的浏览器 any-pointer 不跟着插拔变：真收到鼠标事件就算有
  }
  window.addEventListener('pointerdown', note, { capture: true, passive: true })
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') note(e) }, { capture: true, passive: true })
  if (!device.keyboard) {
    window.addEventListener('keydown', (e) => {
      const el = document.activeElement as HTMLElement | null
      const editing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
      if (!editing && e.key && e.key !== 'Unidentified') device.keyboard = true
    }, { capture: true, passive: true })
  }
}

/** 这个鼠标事件是真的鼠标 / 触控板发的（不是手指轻点后浏览器补发的兼容鼠标事件） */
export function realMouse(e: MouseEvent): boolean {
  const pe = e as PointerEvent
  if (pe.pointerType) return pe.pointerType === 'mouse'
  if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return false
  return device.pointer === 'mouse' || (device.pointer === '' && device.mouse && !device.touch)
}

/** 终端里直接用实体键盘打字：电脑，或者手机 / 平板接了外接键盘 */
export const typesDirectly = () => device.keyboard
