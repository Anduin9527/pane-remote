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
  import { linkAt } from '$lib/links'
  import { t } from '$lib/i18n'

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
      disableStdin: true, cursorBlink: false, cursorStyle: 'bar', theme: THEME,
      allowProposedApi: true, customGlyphs: true, drawBoldTextInBrightColors: false,
    })
    term.open(screenEl)
    try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11' } catch {}
    // 默认用 DOM 渲染（系统原生文字，手机上更清晰）；WebGL 在高 DPR 下字形图集会放大发虚，加 ?gl=1 才启用
    if (new URLSearchParams(location.search).has('gl')) {
      try { const gl = new WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl) } catch {}
    }
    term.write('\x1b[?25l\x1b[?7l') // 不显示 xterm 自己的光标，关掉自动换行（行宽以 WezTerm 为准）
  }

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
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
    return () => {
      off(); ro.disconnect(); term?.dispose(); cancelAnimationFrame(rafId)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('touchend', onTouchEnd)
    }
  })

  // 切 pane：重建终端，避免上一个 pane 的残影
  $effect(() => {
    ui.current
    untrack(() => { if (screenEl) { makeTerm(); layout() } })
  })
  // 尺寸、全屏状态、显示设置、视口变化都要重新排版
  $effect(() => {
    ui.cols; ui.rows; ui.alt; prefs.fit; viewportTick
    if (!prefs.fit) prefs.fs
    untrack(layout)
  })
  let hinted = false
  $effect(() => {
    if (mouseMode() && !hinted) { hinted = true; toast(t('全屏模式：上下滑动滚动，轻点等于鼠标点击'), { duration: 2500 }) }
    if (!mouseMode()) hinted = false
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
    const url = at && linkAt(session.lines[at.line] || '', at.col)
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
