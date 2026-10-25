<script lang="ts">
  // 画面：xterm.js 按格子渲染，列数行数和 WezTerm 一样；滚动交给外层容器
  import { onMount, untrack } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { Unicode11Addon } from '@xterm/addon-unicode11'
  import { WebglAddon } from '@xterm/addon-webgl'
  import { toast } from 'svelte-sonner'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import { sendRaw } from '$lib/api'
  import { prefs } from '$lib/prefs.svelte'
  import { ui, onFrame, mouseMode } from '$lib/session.svelte'
  import * as session from '$lib/session.svelte'
  import { mouseMods } from '$lib/mods.svelte'
  import { linkAt, resolveLink } from '$lib/links'
  import { t } from '$lib/i18n'
  import { device, realMouse, typesDirectly } from '$lib/device.svelte'

  let { viewportTick = 0, onpreview }: { viewportTick?: number; onpreview?: (url: string) => void } = $props()

  const FONT = 'Menlo, "SF Mono", ui-monospace, "PingFang SC", monospace'
  const THEME = { // Tokyo Night，和 WezTerm 的配色一致
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  }
  const MIN_FS = 9 // 再小就看不清了；放不下时宁可超出，底部钉住

  let scroller: HTMLDivElement
  let screenEl: HTMLDivElement
  let term: Terminal | null = null
  let pending: Set<number> | null = null // 等下一帧画的行；null 表示要整屏重画
  let rafId = 0
  let showToBottom = $state(false)
  let ripple = $state<{ x: number; y: number; id: number } | null>(null)

  const ratio = (() => {
    const c = document.createElement('canvas').getContext('2d')!
    c.font = `100px ${FONT}`
    return c.measureText('MMMMMMMMMM').width / 1000
  })()

  function makeTerm() {
    term?.dispose()
    screenEl.textContent = ''
    term = new Terminal({
      cols: ui.cols + 1, rows: Math.max(1, session.lines.length || ui.rows),
      fontFamily: FONT, fontSize: prefs.fs, lineHeight: 1.15, scrollback: 0,
      // 有实体键盘（电脑，或手机 / 平板接了外接键盘）：直接在终端里打字（xterm 把按键翻成控制序列，原样发进 pane）；
      // 没有就靠底部输入栏和快捷键栏。按设备认，不按窗口宽度（笔记本窗口拉窄、开了缩放照样是电脑）
      disableStdin: !typesDirectly(), cursorBlink: false, cursorStyle: 'bar', theme: THEME,
      allowProposedApi: true, customGlyphs: true, drawBoldTextInBrightColors: false,
    })
    term.open(screenEl)
    try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11' } catch {}
    // 默认用 DOM 渲染（系统原生文字，手机上更清晰）；WebGL 在高 DPR 下字形图集会放大发虚，加 ?gl=1 才启用
    if (new URLSearchParams(location.search).has('gl')) {
      try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl) } catch {}
    }
    term.write('\x1b[?25l\x1b[?7l') // 不显示 xterm 自己的光标，关掉自动换行（行宽以 WezTerm 为准）
    if (typesDirectly()) {
      term.onData((d) => sendRaw(ui.current, d))
      term.focus()
    }
  }

  // ---------- 实体键盘、鼠标 / 触控板：粘贴、滚轮、点击、拖动 ----------
  // 粘贴：多行的包成括号粘贴（\e[200~…\e[201~），shell 和 Claude Code 会当成一整段，不会每行都执行。
  // 捕获阶段拦下，xterm 自己不再处理（它不知道程序有没有开括号粘贴，会直接把换行发出去）
  function onPaste(e: ClipboardEvent) {
    if (!typesDirectly()) return
    const text = e.clipboardData?.getData('text/plain')
    e.preventDefault(); e.stopPropagation()
    if (!text) return
    const body = text.replace(/\r\n?/g, '\n')
    sendRaw(ui.current, /\n/.test(body) ? `\x1b[200~${body}\x1b[201~` : body)
  }
  // 全屏程序（vim、less、Claude Code 的全屏界面）：鼠标 / 触控板的操作原样转成 SGR 鼠标序列发给程序。
  // 普通画面不转：滚轮照常滚动页面，拖动是 xterm 自己的选择文字（⌘C 复制）。
  // 只认真的鼠标 / 触控板（pointerType = mouse），所以接了鼠标的 iPhone / iPad 也一样；手指操作走下面的触摸手势
  const MOUSE_BTN: Record<number, number> = { 0: 0, 1: 1, 2: 2 } // 左 / 中 / 右
  const sgrMods = (e: MouseEvent) => ((e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0)) | mouseMods()
  let held: { btn: number; mods: number; col: number; row: number } | null = null
  // 滚轮：捕获阶段拦（xterm 自己的视口会吃掉滚轮事件）。触控板双指滑是一串很小的像素增量，累计够一格才发
  let wheelAcc = 0
  function onWheel(e: WheelEvent) {
    if (!mouseMode()) return
    e.preventDefault(); e.stopPropagation()
    const cell = cellAt(e.clientX, e.clientY) || { col: Math.ceil(ui.cols / 2), row: Math.ceil(ui.rows / 2) }
    wheelAcc += e.deltaMode === 1 ? e.deltaY * STEP : e.deltaMode === 2 ? e.deltaY * STEP * ui.rows : e.deltaY
    const m = sgrMods(e)
    let seq = ''
    while (wheelAcc >= STEP) { seq += `\x1b[<${65 + m};${cell.col};${cell.row}M`; wheelAcc -= STEP }
    while (wheelAcc <= -STEP) { seq += `\x1b[<${64 + m};${cell.col};${cell.row}M`; wheelAcc += STEP }
    if (seq) sendRaw(ui.current, seq)
  }
  function onPointerDown(e: PointerEvent) {
    if (!realMouse(e)) return
    if (typesDirectly()) term?.focus()
    if (!mouseMode() || !(e.button in MOUSE_BTN)) return
    const cell = cellAt(e.clientX, e.clientY)
    if (!cell) return
    e.preventDefault(); e.stopPropagation() // 不让 xterm 开始选择文字
    held = { btn: MOUSE_BTN[e.button], mods: sgrMods(e), ...cell }
    try { scroller.setPointerCapture(e.pointerId) } catch {} // 拖到终端外面松手也收得到
    sendRaw(ui.current, `\x1b[<${held.btn + held.mods};${cell.col};${cell.row}M`)
  }
  function onPointerMove(e: PointerEvent) {
    if (!held || !realMouse(e)) return
    e.preventDefault(); e.stopPropagation()
    const cell = cellAt(e.clientX, e.clientY)
    if (!cell || (cell.col === held.col && cell.row === held.row)) return // 只在换了格子时发
    held.col = cell.col; held.row = cell.row
    sendRaw(ui.current, `\x1b[<${32 + held.btn + held.mods};${cell.col};${cell.row}M`) // 按住拖动：按钮号 + 32
  }
  function onPointerUp(e: PointerEvent) {
    if (!held || !realMouse(e)) return
    e.preventDefault(); e.stopPropagation()
    const cell = cellAt(e.clientX, e.clientY) || held
    sendRaw(ui.current, `\x1b[<${held.btn + held.mods};${cell.col};${cell.row}m`)
    held = null
  }
  // 全屏程序里右键是发给程序的，不弹浏览器菜单
  function onContextMenu(e: MouseEvent) { if (mouseMode() && realMouse(e)) e.preventDefault() }

  // 组件刚卸载时还可能收到一次 scroll 事件（scroller 已经是 null）
  const nearBottom = () => !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
  const setFont = (fs: number) => { if (term && term.options.fontSize !== fs) term.options.fontSize = fs }

  function layout() {
    if (!term) return
    const rows = Math.max(1, session.lines.length || ui.rows)
    // 多留一列：行尾正好落在最后一格的中文，在手机字体里会被裁掉半个
    const cols = ui.cols + 1
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows)
      pending = null
      schedule()
    }
    let fs = prefs.fs
    if (prefs.fit) {
      const avail = scroller.clientWidth - 12
      fs = Math.max(MIN_FS, Math.floor((avail / ((ui.cols + 1) * ratio)) * 0.97 * 10) / 10)
    }
    setFont(fs)
    // 全屏程序没法滚动页面（滑动被当成滚轮发给程序），所以高度也必须塞进屏幕，不然底下几行永远看不到
    if (ui.alt) {
      const availH = scroller.clientHeight - 22
      for (let i = 0; i < 3; i++) {
        const h = screenEl.querySelector('.xterm-screen')?.getBoundingClientRect().height || 0
        if (!h || h <= availH) break
        const next = Math.max(MIN_FS, Math.floor((term.options.fontSize! * (availH / h)) * 10) / 10 - 0.1)
        if (next === term.options.fontSize) break
        setFont(next)
      }
      scroller.scrollTop = scroller.scrollHeight // 放不下时让最底下几行（输入区、最新输出）始终可见
    }
    if (prefs.fit) prefs.fs = term.options.fontSize!
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(flush)
  }
  const lineSeq = (i: number) => `\x1b[${i + 1};1H\x1b[0m\x1b[2K${session.lines[i] || ''}`
  function flush() {
    rafId = 0
    if (!term) return
    const stick = nearBottom()
    let out = ''
    if (pending === null) for (let i = 0; i < session.lines.length; i++) out += lineSeq(i)
    else for (const i of pending) out += lineSeq(i)
    pending = new Set()
    if (out) term.write(out + '\x1b[0m')
    if (stick || ui.alt) scroller.scrollTop = scroller.scrollHeight
    showToBottom = !ui.alt && !nearBottom()
  }

  onMount(() => {
    makeTerm()
    // 从预览页切回来时组件是新建的，手里已有的画面要整屏画一次
    pending = null
    queueMicrotask(() => { layout(); schedule() })
    const off = onFrame((changed) => {
      if (changed === null) { layout(); pending = null }
      else if (pending) for (const i of changed) pending.add(i)
      schedule()
    })
    const ro = new ResizeObserver(() => layout())
    ro.observe(scroller)
    // touchmove 要 preventDefault，必须是非 passive 监听（Svelte 默认把 touch 事件设成 passive）
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: false })
    scroller.addEventListener('touchend', onTouchEnd, { passive: false })
    const cap = { capture: true, passive: false }
    scroller.addEventListener('wheel', onWheel, cap)
    scroller.addEventListener('pointerdown', onPointerDown, cap)
    scroller.addEventListener('pointermove', onPointerMove, cap)
    scroller.addEventListener('pointerup', onPointerUp, cap)
    scroller.addEventListener('pointercancel', onPointerUp, cap)
    scroller.addEventListener('contextmenu', onContextMenu, cap)
    scroller.addEventListener('paste', onPaste, { capture: true })
    return () => {
      scroller.removeEventListener('wheel', onWheel, cap)
      scroller.removeEventListener('pointerdown', onPointerDown, cap)
      scroller.removeEventListener('pointermove', onPointerMove, cap)
      scroller.removeEventListener('pointerup', onPointerUp, cap)
      scroller.removeEventListener('pointercancel', onPointerUp, cap)
      scroller.removeEventListener('contextmenu', onContextMenu, cap)
      scroller.removeEventListener('paste', onPaste, { capture: true })
      off(); ro.disconnect(); term?.dispose(); cancelAnimationFrame(rafId)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
    }
  })

  // 切 pane：重建终端，避免上一个 pane 的残影
  // 认出了实体键盘（比如 iPad 刚接上键盘）：键盘输入是建终端时定的，也要重建
  $effect(() => {
    ui.current; device.keyboard
    untrack(() => { if (screenEl) { makeTerm(); pending = null; layout(); schedule() } })
  })
  // 尺寸、全屏状态、显示设置、视口变化都要重新排版
  $effect(() => {
    ui.cols; ui.rows; ui.alt; prefs.fit; viewportTick
    if (!prefs.fit) prefs.fs
    untrack(layout)
  })
  // 全屏模式的操作提示只在这台手机上提示一次（以前每次打开终端都弹，太吵）
  let hinted = (() => { try { return localStorage.getItem('hintMouse') === '1' } catch { return false } })()
  $effect(() => {
    if (mouseMode() && !hinted) { hinted = true; try { localStorage.setItem('hintMouse', '1') } catch {} toast(t('全屏模式：上下滑动滚动，轻点等于鼠标点击'), { duration: 2500 }) }
  })

  // ---------- 全屏程序：滑动 → SGR 滚轮，轻点 → SGR 鼠标点击 ----------
  let touchY: number | null = null, touchX = 0, startX = 0, startY = 0, startT = 0, acc = 0
  let axis: 'x' | 'y' | null = null
  const STEP = 18

  function cellAt(clientX: number, clientY: number) {
    const el = screenEl.querySelector('.xterm-screen')
    if (!el || !term) return null
    const r = el.getBoundingClientRect()
    const cw = r.width / term.cols, ch = r.height / term.rows
    const col = Math.floor((clientX - r.left) / cw) + 1
    // WezTerm 尺寸不同步时，屏幕上的行数会比程序知道的（pty 的 rows）多，多出来的是顶部残留行，
    // 程序的界面贴着底部画（pane 1：屏幕 37 行、pty 36 行，Claude 画在第 2～37 行）。
    // 鼠标行号要按程序的坐标算：扣掉顶部多出来的行（画面末尾那行是 get-text 多给的空行，不算）
    const top = Math.max(0, term.rows - 1 - ui.rows)
    const row = Math.floor((clientY - r.top) / ch) + 1 - top
    if (col < 1 || row < 1 || col > ui.cols || row > ui.rows) return null
    return { col, row }
  }

  // ---------- 长按：链接 → 在预览中打开 / 复制（相当于电脑上 Shift+点击链接）。任何模式都有效 ----------
  let lpTimer: ReturnType<typeof setTimeout> | undefined
  let lpFired = false
  function lineAt(clientX: number, clientY: number) {
    const el = screenEl.querySelector('.xterm-screen')
    if (!el || !term) return null
    const r = el.getBoundingClientRect()
    const line = Math.floor((clientY - r.top) / (r.height / term.rows))
    const col = Math.floor((clientX - r.left) / (r.width / term.cols))
    if (line < 0 || line >= session.lines.length || col < 0) return null
    return { line, col }
  }
  function longPress(x: number, y: number) {
    lpFired = true
    const at = lineAt(x, y)
    const found = at && linkAt(session.lines[at.line] || '', at.col)
    const url = found && (resolveLink(found, session.currentPane()?.dir) || found) // 相对路径按这个 pane 所在的目录算
    navigator.vibrate?.(10)
    if (!url) { toast(t('这里没有链接')); return }
    toast(url, {
      duration: 8000,
      action: { label: t('在预览中打开'), onClick: () => onpreview?.(url) },
      cancel: { label: t('复制'), onClick: () => navigator.clipboard.writeText(url).then(() => toast(t('已复制链接')), () => toast.error(t('复制失败'))) },
    })
  }

  function onTouchStart(e: TouchEvent) {
    clearTimeout(lpTimer)
    lpFired = false
    if (e.touches.length !== 1) { touchY = null; return }
    const t = e.touches[0]
    touchY = startY = t.clientY
    touchX = startX = t.clientX
    startT = performance.now()
    acc = 0
    axis = null
    lpTimer = setTimeout(() => longPress(startX, startY), 500)
  }
  function onTouchMove(e: TouchEvent) {
    if (touchY === null) return
    const t = e.touches[0]
    if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) clearTimeout(lpTimer)
    if (!mouseMode()) return
    // 先判断方向：横向交给浏览器平移，竖向才转滚轮
    if (!axis) {
      const dx = Math.abs(t.clientX - touchX), dy = Math.abs(t.clientY - touchY)
      if (dx < 6 && dy < 6) return
      axis = dx > dy ? 'x' : 'y'
    }
    if (axis === 'x') return
    e.preventDefault()
    acc += t.clientY - touchY
    touchY = t.clientY
    const col = Math.ceil(ui.cols / 2), row = Math.ceil(ui.rows / 2)
    let seq = ''
    while (acc >= STEP) { seq += `\x1b[<64;${col};${row}M`; acc -= STEP } // 手指往下 = 往上翻
    while (acc <= -STEP) { seq += `\x1b[<65;${col};${row}M`; acc += STEP }
    if (seq) sendRaw(ui.current, seq)
  }
  function onTouchEnd(e: TouchEvent) {
    clearTimeout(lpTimer)
    if (touchY === null) return
    touchY = null
    if (lpFired) { e.preventDefault(); return } // 长按已经处理过
    // 没怎么移动、按得不久 = 轻点：换算成格子坐标，发左键按下 + 松开（⇧ / ⌥ 亮着时带上修饰位）
    if (axis || !mouseMode() || performance.now() - startT > 400) return
    const t = e.changedTouches[0]
    if (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8) return
    const cell = cellAt(t.clientX, t.clientY)
    if (!cell) return
    e.preventDefault() // 不再触发合成的 click / 双击缩放
    const b = mouseMods()
    sendRaw(ui.current, `\x1b[<${b};${cell.col};${cell.row}M\x1b[<${b};${cell.col};${cell.row}m`)
    const box = scroller.getBoundingClientRect()
    ripple = { x: t.clientX - box.left + scroller.scrollLeft, y: t.clientY - box.top + scroller.scrollTop, id: performance.now() }
    setTimeout(() => { ripple = null }, 350)
  }
</script>

<div
  bind:this={scroller}
  class="relative flex-1 overflow-auto overscroll-contain bg-[#1a1b26] text-[#c0caf5] select-none [color-scheme:dark] [-webkit-touch-callout:none]"
  style:touch-action={mouseMode() ? 'pan-x' : 'auto'}
  onscroll={() => (showToBottom = !ui.alt && !nearBottom())}
>
  <div bind:this={screenEl} class="term-screen"></div>
  {#if ripple}
    {#key ripple.id}
      <span
        class="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-[#7aa2f7]/40"
        style:left="{ripple.x}px"
        style:top="{ripple.y}px"
      ></span>
    {/key}
  {/if}
  {#if !ui.hasFrame}
    <div class="absolute inset-0 grid place-items-center p-6 text-center text-sm text-[#8a93a6]">
      {ui.statusMsg || t('连接中…')}
    </div>
  {/if}
</div>

{#if showToBottom}
  <button
    class="fixed right-3.5 z-10 grid size-10 place-items-center rounded-full border bg-card shadow-lg"
    style:bottom="calc(var(--dock-h, 110px) + 12px)"
    aria-label={t('回到底部')}
    onclick={() => (scroller.scrollTop = scroller.scrollHeight)}
  >
    <ArrowDown class="size-4" />
  </button>
{/if}
