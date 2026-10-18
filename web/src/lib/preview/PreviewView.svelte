<script lang="ts">
  // 预览：看电脑上无界面 Chrome（或 Cursor 内置浏览器） 的实时画面（网络是电脑那边的：localhost、内网、代理都照用）。
  // 轻点 = 点击，拖动 = 滚动，双指 = 缩放 / 平移画面，底栏打字 = 输入到页面里当前聚焦的输入框。
  // 电脑模式：电脑那边按桌面浏览器（Mac Chrome 的 UA、1280 宽）渲染，这里等比缩放显示；长按 = 鼠标悬停。
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import X from '@lucide/svelte/icons/x'
  import Layers from '@lucide/svelte/icons/layers'
  import Plus from '@lucide/svelte/icons/plus'
  import Delete from '@lucide/svelte/icons/delete'
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left'
  import Monitor from '@lucide/svelte/icons/monitor'
  import Smartphone from '@lucide/svelte/icons/smartphone'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minimize from '@lucide/svelte/icons/minimize'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import Globe from '@lucide/svelte/icons/globe'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'
  import { appConfig } from '$lib/appConfig.svelte'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'
  import { previewRequest, previewUi } from './request.svelte'
  import { t, tr, lang } from '$lib/i18n'
  import { currentPane } from '$lib/session.svelte'
  import { resolveLink } from '$lib/links'

  type Tab = { id: string; url: string; title: string }
  let nav = $state({ url: '', title: '', loading: false })
  let tabs = $state<{ list: Tab[]; current: string | null }>({ list: [], current: null })
  let status = $state<'connecting' | 'live' | 'closed'>('connecting')
  let address = $state('')
  let editing = $state(false)
  let typed = $state('')
  let tabsOpen = $state(false)
  let fps = $state(0)
  // 来源：chrome = 电脑上的无界面 Chrome；cursor = Cursor IDE 的内置浏览器（固定按电脑尺寸显示，不能新开标签）
  let source = $state<'chrome' | 'cursor'>((() => { try { return localStorage.getItem('previewSource') === 'cursor' ? 'cursor' : 'chrome' } catch { return 'chrome' } })())
  let note = $state('') // Cursor 浏览器没打开网页之类的提示，显示在画面区
  const isCursor = $derived(source === 'cursor' && !!appConfig.modules.cursor)
  // 没开 Cursor 模块（或服务端配置还没拿到时选了 cursor）：按 Chrome 来源连
  $effect(() => { if (appConfig.loaded && !appConfig.modules.cursor && source === 'cursor') { source = 'chrome'; connect() } })

  let stage: HTMLDivElement
  let canvas: HTMLCanvasElement
  let ws: WebSocket | null = null
  let meta: { seq: number; w: number; h: number; desktop?: boolean } | null = null
  let view = { w: 0, h: 0 }
  let frameTimes: number[] = []

  const DESKTOP_KEY = 'previewDesktop'
  let desktop = $state((() => { try { return localStorage.getItem(DESKTOP_KEY) === '1' } catch { return false } })())
  let kbOpen = $state(false) // 全屏时临时显示输入栏

  // ---------- 画面摆放：页面 CSS 尺寸 frame 等比缩放进 stage（base），再叠加双指缩放 zoom 和平移 pan ----------
  let frame = $state({ w: 0, h: 0 })
  let stageSize = $state({ w: 0, h: 0 })
  let zoom = $state(1)
  let pan = $state({ x: 0, y: 0 })
  const base = $derived.by(() => {
    if (!frame.w || !stageSize.w) return { s: 1, x: 0, y: 0 }
    const s = Math.min(stageSize.w / frame.w, stageSize.h / frame.h)
    return { s, x: (stageSize.w - frame.w * s) / 2, y: Math.max(0, (stageSize.h - frame.h * s) / 2) }
  })
  function clampPan(p: { x: number; y: number }, z = zoom) {
    const W = frame.w * base.s * z, H = frame.h * base.s * z
    const x = W > stageSize.w ? Math.min(-base.x, Math.max(stageSize.w - W - base.x, p.x)) : (stageSize.w - W) / 2 - base.x
    const y = H > stageSize.h ? Math.min(-base.y, Math.max(stageSize.h - H - base.y, p.y)) : (stageSize.h - H) / 2 - base.y
    return { x, y }
  }
  function resetZoom() { zoom = 1; pan = { x: 0, y: 0 } }
  /** 屏幕坐标 → 页面 CSS 坐标 */
  function toPage(clientX: number, clientY: number) {
    const r = stage.getBoundingClientRect()
    const k = base.s * zoom
    return { x: Math.round((clientX - r.left - base.x - pan.x) / k), y: Math.round((clientY - r.top - base.y - pan.y) / k) }
  }

  function setDesktop(v: boolean) {
    desktop = v
    try { localStorage.setItem(DESKTOP_KEY, v ? '1' : '0') } catch {}
    resetZoom()
    if (matchMedia('(orientation: landscape)').matches) setImmersive(v) // 已经横着拿：直接进 / 出全屏（会触发尺寸变化，自动重发 viewport）
    sendViewport()
    toast(v ? t('电脑模式：桌面版 Chrome 的 UA，按 1280 宽渲染，已重新加载') : t('手机模式：iPhone Safari 的 UA，已重新加载'), { description: v ? t('双指缩放看细节，长按 = 鼠标悬停；横过手机自动全屏') : undefined })
  }
  function setSource(v: 'chrome' | 'cursor') {
    if (v === source) return
    source = v
    try { localStorage.setItem('previewSource', v) } catch {}
    note = ''
    nav = { url: '', title: '', loading: false }
    tabs = { list: [], current: null }
    resetZoom()
    connect()
    toast(v === 'cursor' ? t('预览切到 Cursor 的内置浏览器') : t('预览切到电脑上的 Chrome'))
  }
  function setImmersive(v: boolean) {
    previewUi.immersive = v
    kbOpen = false
  }

  const RECENT_KEY = 'previewRecent'
  let recent = $state<string[]>((() => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] } })())
  function remember(u: string) {
    recent = [u, ...recent.filter((x) => x !== u)].slice(0, 8)
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)) } catch {}
  }

  // 地址栏的路径提示：输入 ~/ 或 / 开头时，列出电脑上这一层的文件和文件夹；点文件夹往下走，「打开这个文件夹」在预览里看列表
  type Entry = { name: string; dir: boolean }
  const lsCache = new Map<string, Entry[]>()
  let entries = $state<Entry[]>([])
  let lsTimer: ReturnType<typeof setTimeout> | undefined
  const isPath = $derived(/^[~/]/.test(address))
  const pathDir = $derived(isPath ? address.slice(0, address.lastIndexOf('/') + 1) || '/' : '')
  const pathPrefix = $derived(isPath ? address.slice(address.lastIndexOf('/') + 1).toLowerCase() : '')
  $effect(() => {
    const dir = pathDir
    if (!editing || !dir) return
    if (lsCache.has(dir)) { entries = lsCache.get(dir)!; return }
    clearTimeout(lsTimer)
    lsTimer = setTimeout(async () => {
      try {
        const r = await fetch(`api/ls?path=${encodeURIComponent(dir)}`, { cache: 'no-store' })
        const d: Entry[] = r.ok ? await r.json() : []
        lsCache.set(dir, d)
        if (pathDir === dir) entries = d
      } catch {}
    }, 150)
  })
  const pathMatches = $derived.by(() => {
    if (!isPath) return []
    const starts = entries.filter((e) => e.name.toLowerCase().startsWith(pathPrefix))
    const contains = pathPrefix ? entries.filter((e) => !e.name.toLowerCase().startsWith(pathPrefix) && e.name.toLowerCase().includes(pathPrefix)) : []
    return [...starts, ...contains].slice(0, 80)
  })
  // 当前 pane 所在的目录（~/ 开头）：地址栏里 ./、../ 按它算，提示列表顶上给一个直达入口
  const paneCwd = $derived(currentPane()?.cwd || '')
  $effect(() => {
    if (!editing || !paneCwd || !/^\.{1,2}\//.test(address)) return
    const abs = resolveLink(address, paneCwd)
    if (abs) address = abs + (address.endsWith('/') && abs !== '/' ? '/' : '')
  })
  function pickEntry(e: Entry) {
    address = pathDir + e.name + (e.dir ? '/' : '')
    if (!e.dir) go()
  }

  const send = (m: object) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }

  // 别处要求打开的地址（阅读模式里点的链接）：连上就打开
  let handled = 0
  function takeRequest() {
    if (previewRequest.n === handled || ws?.readyState !== WebSocket.OPEN) return
    handled = previewRequest.n
    address = previewRequest.url
    send({ t: 'open', url: previewRequest.url })
    remember(previewRequest.url)
  }
  $effect(() => { previewRequest.n; takeRequest() })

  function sendViewport() {
    const r = stage.getBoundingClientRect()
    view = { w: Math.floor(r.width), h: Math.floor(r.height) }
    stageSize = { ...view }
    pan = clampPan(pan)
    if (view.w < 50 || view.h < 50) return
    // 像素密度最多 2：3 倍图的流量多一倍多，手机上看差别不大。lang：电脑那边生成的文件浏览器页面跟着手机的界面语言
    send({ t: 'viewport', w: view.w, h: view.h, dpr: Math.min(2, devicePixelRatio || 2), desktop: desktop || source === 'cursor', lang })
  }

  let retry = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  function connect() {
    clearTimeout(retryTimer)
    ws?.close()
    status = 'connecting'
    const url = new URL('api/preview', location.href)
    if (source === 'cursor' && appConfig.modules.cursor !== false) url.searchParams.set('source', 'cursor')
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const sock = new WebSocket(url)
    sock.binaryType = 'blob'
    ws = sock
    sock.onopen = () => { retry = 0; sendViewport(); takeRequest() }
    sock.onmessage = async (e) => {
      if (typeof e.data !== 'string') {
        const m = meta
        meta = null
        if (!m) return
        try {
          const bmp = await createImageBitmap(e.data as Blob)
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height }
          canvas.getContext('2d')!.drawImage(bmp, 0, 0)
          if (m.w !== frame.w || m.h !== frame.h) { frame = { w: m.w, h: m.h }; resetZoom() }
          bmp.close()
          status = 'live'
          note = ''
          const now = performance.now()
          frameTimes = [...frameTimes.filter((t) => now - t < 2000), now]
          fps = Math.round(frameTimes.length / 2)
        } finally {
          send({ t: 'ack', seq: m.seq }) // 画完才 ack，电脑那头据此决定什么时候截下一张
        }
        return
      }
      const m = JSON.parse(e.data)
      if (m.t === 'frame') meta = m
      else if (m.t === 'nav') { nav = m; if (!editing) address = m.url === 'about:blank' ? '' : m.url }
      else if (m.t === 'tabs') tabs = m
      else if (m.t === 'error') { if (source === 'cursor' && /没打开网页|关掉了|没有接入/.test(m.msg)) note = tr(m.msg); else toast.error(tr(m.msg)) }
      else if (m.t === 'notice') { note = ''; toast(tr(m.msg)) }
      else if (m.t === 'opened') toast(t('电脑上要打开的网页，已在这里打开'), { description: m.url })
      else if (m.t === 'closed') { status = 'closed'; if (m.msg) toast.error(tr(m.msg)) }
    }
    sock.onclose = (e) => {
      if (ws !== sock) return
      status = 'closed'
      if (e.code === 4000) { toast(tr(e.reason) || t('另一台设备打开了预览')); return }
      if (document.visibilityState === 'visible') retryTimer = setTimeout(connect, Math.min(10000, 800 * 2 ** retry++))
    }
  }

  onMount(() => {
    connect()
    let t: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(sendViewport, 200) })
    ro.observe(stage)
    const vis = () => { if (document.visibilityState === 'visible' && (!ws || ws.readyState > 1)) connect() }
    document.addEventListener('visibilitychange', vis)
    stage.addEventListener('touchstart', onStart, { passive: true })
    stage.addEventListener('touchmove', onMove, { passive: false })
    stage.addEventListener('touchend', onEnd, { passive: false })
    stage.addEventListener('touchcancel', onEnd, { passive: false })
    // 电脑模式下横过手机：自动全屏；竖回来退出
    const mq = matchMedia('(orientation: landscape)')
    const orient = () => { if (desktop) setImmersive(mq.matches) }
    mq.addEventListener('change', orient)
    orient()
    return () => {
      mq.removeEventListener('change', orient)
      previewUi.immersive = false
      ro.disconnect()
      document.removeEventListener('visibilitychange', vis)
      clearTimeout(retryTimer)
      ws?.close()
      ws = null
    }
  })

  function go(e?: Event) {
    e?.preventDefault()
    let u = address.trim()
    if (/^\.{1,2}(\/|$)/.test(u) && paneCwd) u = resolveLink(u, paneCwd) || u
    if (!u) return
    send({ t: 'open', url: u })
    remember(u)
    editing = false
    ;(document.activeElement as HTMLElement)?.blur()
  }

  // ---------- 触摸：轻点 → 点击；拖动 → 滚动（按帧合并）；双指 → 缩放 / 平移画面；电脑模式长按 → 悬停 ----------
  let sx = 0, sy = 0, lx = 0, ly = 0, st = 0, moved = false
  let accX = 0, accY = 0, raf = 0
  let gesture: 'none' | 'one' | 'pinch' = 'none'
  let pinch = { d: 1, z: 1, cx: 0, cy: 0 }
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let held = false
  const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1
  function mid(a: Touch, b: Touch) {
    const r = stage.getBoundingClientRect()
    return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top }
  }
  function onStart(e: TouchEvent) {
    clearTimeout(holdTimer)
    if (e.touches.length === 2) {
      gesture = 'pinch'
      const [a, b] = [e.touches[0], e.touches[1]]
      const m = mid(a, b)
      // 双指中点下面那块画面（按缩放 1 的显示坐标）：缩放 / 平移时让它跟着手指走
      pinch = { d: dist(a, b), z: zoom, cx: (m.x - base.x - pan.x) / zoom, cy: (m.y - base.y - pan.y) / zoom }
      return
    }
    if (e.touches.length !== 1 || gesture === 'pinch') return
    gesture = 'one'
    const t = e.touches[0]
    sx = lx = t.clientX; sy = ly = t.clientY; st = performance.now(); moved = false; held = false
    if (desktop || isCursor) holdTimer = setTimeout(() => { held = true; send({ t: 'hover', ...toPage(sx, sy) }) }, 500)
  }
  function onMove(e: TouchEvent) {
    e.preventDefault()
    if (gesture === 'pinch') {
      if (e.touches.length < 2) return
      const [a, b] = [e.touches[0], e.touches[1]]
      const m = mid(a, b)
      const z = Math.min(6, Math.max(1, pinch.z * dist(a, b) / pinch.d))
      zoom = z
      pan = clampPan({ x: m.x - base.x - pinch.cx * z, y: m.y - base.y - pinch.cy * z }, z)
      return
    }
    if (gesture !== 'one' || e.touches.length !== 1) return
    const t = e.touches[0]
    if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) { moved = true; clearTimeout(holdTimer) }
    if (!moved || held) return
    // 手指挪多少，页面就跟着挪多少（换算成页面的 CSS 像素）
    const k = base.s * zoom
    accX += (lx - t.clientX) / k
    accY += (ly - t.clientY) / k
    lx = t.clientX; ly = t.clientY
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0
      const p = toPage(lx, ly)
      if (accX || accY) send({ t: 'scroll', x: p.x, y: p.y, dx: Math.round(accX), dy: Math.round(accY) })
      accX = accY = 0
    })
  }
  function onEnd(e: TouchEvent) {
    clearTimeout(holdTimer)
    if (e.touches.length) return // 还有手指在屏幕上：等全部抬起
    const g = gesture
    gesture = 'none'
    if (g !== 'one' || moved || held || performance.now() - st > 500 || e.type === 'touchcancel') return
    e.preventDefault()
    const t = e.changedTouches[0]
    send({ t: 'tap', ...toPage(t.clientX, t.clientY) })
  }

  function typeText(e: Event) {
    e.preventDefault()
    if (typed) send({ t: 'text', s: typed })
    typed = ''
  }
  const key = (k: string) => send({ t: 'key', key: k })
  const floatBtn = 'grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm active:bg-black/70'
  const iconBtn = 'grid size-9 flex-none place-items-center rounded-lg text-muted-foreground active:bg-accent disabled:opacity-40'
</script>

{#if !previewUi.immersive}
<div class="flex items-center gap-1 border-b bg-card px-1.5 py-1.5">
  {#if appConfig.modules.cursor}
  <button class={cn(iconBtn, isCursor && 'bg-accent text-foreground')} aria-label={isCursor ? t('来源：Cursor 浏览器（点一下换成电脑 Chrome）') : t('来源：电脑 Chrome（点一下换成 Cursor 浏览器）')} onclick={() => setSource(isCursor ? 'chrome' : 'cursor')}>
    {#if isCursor}<CursorIcon class="size-4" />{:else}<Globe class="size-4" />{/if}
  </button>
  {/if}
  <button class={iconBtn} aria-label={t('后退')} onclick={() => send({ t: 'back' })}><ArrowLeft class="size-4" /></button>
  <button class={iconBtn} aria-label={t('前进')} onclick={() => send({ t: 'forward' })}><ArrowRight class="size-4" /></button>
  <form class="relative min-w-0 flex-1" onsubmit={go}>
    <input
      bind:value={address}
      onfocus={(e) => { editing = true; (e.currentTarget as HTMLInputElement).select() }}
      onblur={() => setTimeout(() => (editing = false), 150)}
      placeholder={t('网址、localhost:3000、~/路径 或 ./相对路径')}
      enterkeyhint="go"
      autocapitalize="off"
      spellcheck="false"
      {...{ autocorrect: 'off' }}
      class="h-9 w-full rounded-lg border bg-background px-2.5 font-mono text-[14px] outline-none focus:ring-2 focus:ring-ring"
    />
    {#if nav.loading}<span class="absolute right-0 bottom-0 left-0 h-0.5 animate-pulse rounded bg-primary"></span>{/if}
  </form>
  <button class={iconBtn} aria-label={nav.loading ? t('停止') : t('刷新')} onclick={() => send({ t: 'reload' })}>
    {#if nav.loading}<X class="size-4" />{:else}<RotateCw class="size-4" />{/if}
  </button>
  <button class={cn(iconBtn, 'relative')} aria-label={t('标签页')} onclick={() => (tabsOpen = true)}>
    <Layers class="size-4" />
    {#if tabs.list.length > 1}<span class="absolute top-0.5 right-0.5 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">{tabs.list.length}</span>{/if}
  </button>
  {#if !isCursor}
  <button class={cn(iconBtn, desktop && 'bg-accent text-foreground')} aria-label={desktop ? t('电脑模式（点一下换回手机模式）') : t('手机模式（点一下换成电脑模式）')} aria-pressed={desktop} onclick={() => setDesktop(!desktop)}>
    {#if desktop}<Monitor class="size-4" />{:else}<Smartphone class="size-4" />{/if}
  </button>
  {/if}
</div>
{/if}

{#if previewUi.immersive}
  <!-- 全屏时地址栏收起来；正在编辑地址（比如从输入栏切回）时不显示提示列表 -->
{:else if editing && isPath}
  <div class="max-h-[45dvh] overflow-y-auto overscroll-contain border-b bg-card px-1.5 pb-1.5">
    <button class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-primary active:bg-accent" onpointerdown={(ev) => ev.preventDefault()} onclick={() => { address = pathDir; go() }}>
      <span class="flex-none">📂</span>
      <span class="min-w-0 truncate text-[13px] font-medium">{t('打开这个文件夹')} <span class="font-mono">{pathDir}</span></span>
    </button>
    {#each pathMatches as e (e.name)}
      <button class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left active:bg-accent" onpointerdown={(ev) => ev.preventDefault()} onclick={() => pickEntry(e)}>
        <span class="flex-none text-muted-foreground">{e.dir ? '📁' : '📄'}</span>
        <span class="min-w-0 truncate font-mono text-[13px]">{e.name}{e.dir ? '/' : ''}</span>
      </button>
    {:else}
      <p class="px-2.5 py-2 text-xs text-muted-foreground">{t('没有匹配的文件或文件夹')}</p>
    {/each}
  </div>
{:else if editing && (recent.length || paneCwd)}
  <div class="border-b bg-card px-1.5 pb-1.5">
    {#if paneCwd}
      <button class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-primary active:bg-accent" onpointerdown={(e) => e.preventDefault()} onclick={() => { address = paneCwd + '/'; go() }}>
        <span class="flex-none">📂</span>
        <span class="min-w-0 truncate text-[13px] font-medium">{t('当前 pane 的目录')} <span class="font-mono">{paneCwd}</span></span>
      </button>
    {/if}
    {#each recent as u (u)}
      <button class="block w-full truncate rounded-md px-2.5 py-2 text-left font-mono text-[13px] active:bg-accent" onpointerdown={(e) => e.preventDefault()} onclick={() => { address = u; go() }}>{u}</button>
    {/each}
  </div>
{/if}

<div bind:this={stage} class={cn('relative min-h-0 flex-1 touch-none overflow-hidden', desktop || isCursor ? 'bg-neutral-800' : 'bg-white')}>
  <canvas
    bind:this={canvas}
    class="absolute top-0 left-0 origin-top-left bg-white"
    style:width="{(frame.w || stageSize.w) * base.s}px"
    style:height="{(frame.h || stageSize.h) * base.s}px"
    style:transform="translate({base.x + pan.x}px, {base.y + pan.y}px) scale({zoom})"
  ></canvas>
  {#if status !== 'live' || note}
    <div class="absolute inset-0 grid place-items-center bg-background/80 p-6 text-center text-sm text-muted-foreground">
      {#if note}<div class="grid max-w-xs gap-2"><CursorIcon class="mx-auto size-6" />{note}</div>
      {:else if status === 'connecting'}{isCursor ? t('正在连接 Cursor 的浏览器…') : t('正在连接电脑上的浏览器…')}{:else}
        <div class="grid gap-3">{t('预览已断开')}<Button size="sm" onclick={connect}>{t('重新连接')}</Button></div>
      {/if}
    </div>
  {/if}
  {#if status === 'live'}
    <span class="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/40 px-1.5 text-[10px] leading-4 text-white">{fps} fps{zoom > 1.01 ? ` · ${zoom.toFixed(1)}×` : ''}</span>
  {/if}
  <!-- 浮动按钮：缩放复位、全屏；全屏时再加后退、键盘、切模式 -->
  <div
    class="absolute top-1.5 flex gap-1"
    style:right="calc(env(safe-area-inset-right) + 6px)"
    style:top={previewUi.immersive ? 'calc(env(safe-area-inset-top) + 6px)' : undefined}
    ontouchstart={(e) => e.stopPropagation()}
    ontouchend={(e) => e.stopPropagation()}
  >
    {#if zoom > 1.01}
      <button class={floatBtn} aria-label={t('缩放复位')} onclick={resetZoom}><span class="text-[11px] font-semibold">1×</span></button>
    {/if}
    {#if previewUi.immersive}
      <button class={floatBtn} aria-label={t('后退')} onclick={() => send({ t: 'back' })}><ArrowLeft class="size-4" /></button>
      <button class={floatBtn} aria-label={t('刷新')} onclick={() => send({ t: 'reload' })}><RotateCw class="size-4" /></button>
      <button class={cn(floatBtn, kbOpen && 'bg-primary')} aria-label={t('输入')} onclick={() => (kbOpen = !kbOpen)}><Keyboard class="size-4" /></button>
      {#if !isCursor}
      <button class={floatBtn} aria-label={desktop ? t('换成手机模式') : t('换成电脑模式')} onclick={() => setDesktop(!desktop)}>
        {#if desktop}<Smartphone class="size-4" />{:else}<Monitor class="size-4" />{/if}
      </button>
      {/if}
    {/if}
    <button class={floatBtn} aria-label={previewUi.immersive ? t('退出全屏') : t('全屏')} onclick={() => setImmersive(!previewUi.immersive)}>
      {#if previewUi.immersive}<Minimize class="size-4" />{:else}<Maximize class="size-4" />{/if}
    </button>
  </div>
</div>

{#if !previewUi.immersive || kbOpen}
<form class="flex items-center gap-1.5 border-t bg-card px-2 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+6px)]" style:padding-left="calc(env(safe-area-inset-left) + 8px)" style:padding-right="calc(env(safe-area-inset-right) + 8px)" onsubmit={typeText}>
  <input
    bind:value={typed}
    placeholder={t('先点页面里的输入框，再在这里打字')}
    enterkeyhint="send"
    autocapitalize="off"
    spellcheck="false"
    class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-base outline-none focus:ring-2 focus:ring-ring"
  />
  <button type="button" class={iconBtn} aria-label={t('退格')} onpointerdown={(e) => e.preventDefault()} onclick={() => key('Backspace')}><Delete class="size-4" /></button>
  <button type="button" class={iconBtn} aria-label={t('回车')} onpointerdown={(e) => e.preventDefault()} onclick={() => key('Enter')}><CornerDownLeft class="size-4" /></button>
  <Button type="submit" size="sm" class="h-9" onpointerdown={(e: PointerEvent) => e.preventDefault()}>{t('输入')}</Button>
</form>
{/if}

<Drawer.Root bind:open={tabsOpen}>
  <Drawer.Content>
    <Drawer.Header class="flex-row items-center justify-between border-b py-3">
      <Drawer.Title>{t('标签页')}</Drawer.Title>
      {#if !isCursor}<Button size="sm" class="rounded-full" onclick={() => { send({ t: 'new' }); tabsOpen = false }}><Plus /> {t('新标签')}</Button>{:else}<span class="text-xs text-muted-foreground">{t('Cursor 浏览器的标签在 Cursor 里开关')}</span>{/if}
    </Drawer.Header>
    <div class="grid px-1.5 pb-[calc(env(safe-area-inset-bottom)+8px)]">
      {#each tabs.list as tab (tab.id)}
        <div class="flex items-center gap-1">
          <button class={cn('grid min-w-0 flex-1 gap-0.5 rounded-[10px] px-3 py-2.5 text-left active:bg-accent', tab.id === tabs.current && 'bg-accent')} onclick={() => { send({ t: 'switch', id: tab.id }); tabsOpen = false }}>
            <span class="truncate font-medium">{tab.title || t('无标题')}</span>
            <span class="truncate font-mono text-xs text-muted-foreground">{tab.url}</span>
          </button>
          <Button variant="ghost" size="icon" aria-label={t('关闭标签')} onclick={() => send({ t: 'close', id: tab.id })}><X /></Button>
        </div>
      {/each}
    </div>
  </Drawer.Content>
</Drawer.Root>
