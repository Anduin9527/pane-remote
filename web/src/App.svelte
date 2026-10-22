<script lang="ts">
  import ModelChip from '$lib/components/ModelChip.svelte'
  import LeaseGate from '$lib/components/LeaseGate.svelte'
  import { onMount, untrack } from 'svelte'
  import { Toaster } from '$lib/components/ui/sonner'
  import { toast } from 'svelte-sonner'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { incidents } from '$lib/incidents.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import KeyBar from '$lib/components/KeyBar.svelte'
  import Composer from '$lib/components/Composer.svelte'
  import PaneSheet from '$lib/components/PaneSheet.svelte'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import PluginsIcon from '$lib/plugins/PluginsIcon.svelte'
  import { appConfig, loadAppConfig } from '$lib/appConfig.svelte'
  import PromptBar from '$lib/components/PromptBar.svelte'
  import { cur, selectSession as selectCursorSession, onSelectSession as onSelectCursor, reconnectCursor } from '$lib/cursor/cursor.svelte'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'
  import AgentAsk from '$lib/components/AgentAsk.svelte'
  import PluginLayer from '$lib/plugins/PluginLayer.svelte'
  import PluginRoute from '$lib/plugins/PluginRoute.svelte'
  import { plugins, info as pluginInfo } from '$lib/plugins/plugins.svelte'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import GitFork from '@lucide/svelte/icons/git-fork'
  import Clock from '@lucide/svelte/icons/alarm-clock'
  import { crons, refreshCrons } from '$lib/claude/crons.svelte'
  import DraftBar from '$lib/components/DraftBar.svelte'
  import AgentFocusBar from '$lib/components/AgentFocusBar.svelte'
  import { onSendError, type CreateTarget, type Pane } from '$lib/api'
  import { pushStatus } from '$lib/push'
  import { ui, boot, loadPanes, select, onSelect, setStatus, setPaused, onOpenUrl, reconnectPane } from '$lib/session.svelte'
  import { activeSource, waitingCount } from '$lib/sessions.svelte'
  import { route, parse, navigate, openSheet, sheetBinding, go, paneView, cursorView, pluginView, sameView } from '$lib/router.svelte'
  import { openInPreview } from '$lib/preview/request.svelte'
  import { update } from '$lib/update.svelte'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'

  // 只在需要时下载的部分（首屏只有外壳、会话列表、发送栏）：对话视图（marked / DOMPurify）、终端（xterm）、Cursor、各种面板。
  // 预览、这台电脑、看屏幕（noVNC）是平台自带的插件（lib/plugins/builtin），由插件层打开、按需下载
  const ChatView = () => import('$lib/claude/ChatView.svelte')
  const TerminalView = () => import('$lib/term/TerminalView.svelte')
  const CursorView = () => import('$lib/cursor/CursorView.svelte')

  let ctrl = $state(false)
  let actOpen = $state(false)
  let createOpen = $state(false)
  let renameOpen = $state(false)
  let notifOpen = $state(false)
  loadAppConfig()
  let keysOpen = $state(false)
  let claudeOpen = $state(false)
  let cronOpen = $state(false)
  let readerOpen = $state(false)
  let widthOpen = $state(false)
  // 跟着地址走的面板（手机的返回手势能关掉）：会话列表、待办、问题报告
  const sessionsSheet = sheetBinding('sessions')
  const inboxSheet = sheetBinding('inbox')
  const incidentSheet = sheetBinding('incident')
  const pickOpen = $derived(sessionsSheet.get())
  const inboxOpen = $derived(inboxSheet.get())
  const incidentOpen = $derived(incidentSheet.get())
  const openIncident = (id = '') => { incidents.focus = id; openSheet(id ? `incident:${id}` : 'incident') }
  // 地址里带了具体哪一条（推送点进来）：交给面板打开那一条
  $effect(() => { const m = route.sheet.match(/^incident:([0-9a-f]{12})$/); if (m) untrack(() => (incidents.focus = m[1])) })
  // 面板第一次打开时才下载，之后留着（关掉的动画、里面的状态都还在）
  const once = $state<Record<string, boolean>>({})
  $effect(() => {
    const now: Record<string, boolean> = { act: actOpen, create: createOpen, rename: renameOpen, notif: notifOpen, keys: keysOpen, claude: claudeOpen, cron: cronOpen, reader: readerOpen, width: widthOpen, inbox: inboxOpen, incident: incidentOpen }
    untrack(() => { for (const [k, v] of Object.entries(now)) if (v && !once[k]) once[k] = true })
  })

  // 切到 Claude 会话的 pane 时读一下它的定时任务：有任务才在会话栏显示入口
  $effect(() => { if (ui.current && ui.claude?.agent === 'claude' && ui.claude.session) refreshCrons() })
  const cronTasks = $derived(crons.pane === ui.current && ui.claude?.agent === 'claude' ? crons.data?.tasks ?? [] : [])
  // 有 agent 会话的 pane：对话视图 / 原始画面（终端），每个 pane 各自记住（存在手机本地）。没设置过的默认对话；普通 shell 一直是终端
  let termViews = $state<Record<string, 'term' | 'chat'>>((() => { try { return JSON.parse(localStorage.getItem('termViews') || '{}') } catch { return {} } })())
  $effect(() => { try { localStorage.setItem('termViews', JSON.stringify($state.snapshot(termViews))) } catch {} })
  const termView = $derived((ui.current && termViews[ui.current]) || 'chat')
  const setView = (v: 'term' | 'chat') => { if (ui.current) termViews[ui.current] = v }
  const chatMode = $derived(!!ui.claude && termView === 'chat')
  // 还不知道这个 pane 有没有 agent 会话时先等一下（最多 1.5 秒），免得白白下载、初始化一次终端又换成对话
  let waited = $state(false)
  $effect(() => { ui.current; waited = false; const tm = setTimeout(() => (waited = true), 1500); return () => clearTimeout(tm) })
  const viewReady = $derived(ui.claudeChecked || waited)

  // 当前视图（地址为空时也当成 pane）
  const view = $derived(route.view)
  const onPane = $derived(view.kind === 'pane' || view.kind === 'none')
  const plugin = $derived(view.kind === 'plugin' ? view.id : '')
  const source = $derived(activeSource())
  const waiting = $derived(waitingCount(!plugin))

  // ---------- 路由 ↔ 会话 ----------
  let booted = $state(false)
  // 别处选了 pane（列表、待办、提问、新建…）：地址跟过去（在 Cursor / 预览 / 插件页也会切回 pane）
  onSelect((id) => { if (!(view.kind === 'pane' && view.pane === id)) go(paneView(id)) })
  // Cursor 页里切了会话（分叉、新建后跟过去）：草稿那一条直接换掉，其它新增一条历史
  onSelectCursor((id) => {
    if (view.kind === 'cursor' && view.id === id) return
    if (view.kind === 'cursor' && !view.id) navigate({ view: cursorView(id) }, { replace: true })
    else go(cursorView(id))
  })
  // 地址 → 数据：pane 号变了就切 pane（列表里没有先刷新一次，还没有就留在当前 pane 并改正地址）
  $effect(() => {
    const v = route.view
    if (v.kind === 'pane' && booted && v.pane !== ui.current) {
      untrack(() => {
        if (ui.panes.some((p) => String(p.pane) === v.pane)) return select(v.pane, { quiet: true })
        loadPanes().catch(() => ui.panes).then((list) => {
          if (!sameView(route.view, v)) return
          if (list.some((p) => String(p.pane) === v.pane)) select(v.pane, { quiet: true })
          else if (ui.current) navigate({ view: paneView(ui.current), sheet: route.sheet }, { replace: true })
        })
      })
    }
    if (v.kind === 'cursor' && v.id && v.id !== untrack(() => cur.id)) untrack(() => selectCursorSession(v.id, { quiet: true }))
  })
  // 服务端没开 Cursor 模块（pane-remote enable cursor）：Cursor 的地址回到 pane
  $effect(() => {
    if (appConfig.loaded && !appConfig.modules.cursor && view.kind === 'cursor') untrack(() => navigate({ view: ui.current ? paneView(ui.current) : { kind: 'none' } }, { replace: true }))
  })
  // 不在 pane 上时断开终端画面流：服务端据此知道你没在看那个 pane，该推的通知照推
  const away = () => !(route.view.kind === 'pane' || route.view.kind === 'none')
  setPaused(away())
  $effect(() => { setPaused(away()) })

  // 地址里带了要在预览里打开的网页（?open=）：谁都能构造这种地址（别的网页可以链接过来），所以不直接打开，要点一下确认：
  // 预览浏览器跑在电脑上，能访问本机服务和内网。推送点进来（页面开着、service worker 发消息）的是可信的，直接打开
  $effect(() => {
    const u = route.open
    if (!u) return
    untrack(() => {
      navigate({ view: route.view, sheet: route.sheet }, { replace: true })
      setTimeout(() => toast(t('要在预览里打开这个网页吗？'), { description: u.slice(0, 300), duration: 15000, action: { label: t('打开'), onClick: () => previewUrl(u) } }), 600)
    })
  })

  function openCursorSession(id: string) {
    go(cursorView(id))
  }
  let pushOn = $state(false)
  let moreLoaded = $state(false)
  let moreOpen = $state(false)
  let actPane = $state<Pane | null>(null)
  let widthPane = $state<Pane | null>(null)
  function openWidth(p: Pane | null | undefined) { if (p) { widthPane = p; widthOpen = true } }
  let createTarget = $state<CreateTarget>({})
  let viewportTick = $state(0)
  let dock = $state<HTMLDivElement>()

  // 状态条会被下一帧画面刷回「已连接」，发送失败另外弹一条提示，免得没看到
  onSendError((msg) => { setStatus('err', msg); toast.error(msg, { id: 'send-error' }) })

  // 电脑要打开网页：打开预览插件（地址 #/plugin/preview，插件层把它开到前台），连上后打开这个网页
  function previewUrl(url: string) {
    // 没开预览模块：网址直接在手机浏览器里开（本机地址、文件手机上打不开，就算了）
    if (appConfig.loaded && !appConfig.modules.preview) {
      if (/^https?:\/\//.test(url) && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(url)) window.open(url, '_blank', 'noopener')
      else toast(t('预览模块没开，电脑上的地址和文件在手机上打不开'), { description: url })
      return
    }
    openInPreview(url)
    go(pluginView('preview'))
  }
  onOpenUrl((url) => {
    toast(t('电脑要打开一个网页'), { description: url, duration: 10000, action: { label: t('在预览中打开'), onClick: () => previewUrl(url) } })
  })

  // 视口：iOS 键盘弹出时可视高度变小，把整页高度设成可视高度，底栏跟着顶上来
  function fitViewport() {
    const vv = window.visualViewport
    const root = document.documentElement.style
    root.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`)
    if (dock) root.setProperty('--dock-h', `${dock.offsetHeight}px`)
    if (vv) window.scrollTo(0, 0)
    viewportTick++
  }

  // 推送点进来（页面开着）：service worker 只发一个地址过来，照着导航。它带来的预览网页是可信的，直接打开
  function fromPush(url: string) {
    const r = parse(url.slice(Math.max(0, url.indexOf('#'))))
    if (r.open) return previewUrl(r.open)
    navigate(url)
  }

  onMount(() => {
    fitViewport()
    window.visualViewport?.addEventListener('resize', fitViewport)
    window.addEventListener('resize', fitViewport)
    const onSw = (e: MessageEvent) => {
      const d = e.data
      if (d?.type === 'navigate' && typeof d.url === 'string') return fromPush(d.url)
      // 旧版 service worker（还没更新的那几分钟）发的消息
      if (d?.type === 'open-preview') return previewUrl(d.url)
      if (d?.type === 'open-cursor') return go(cursorView(d.id))
      if (d?.type === 'open-incident') return openIncident(d.id)
      if (d?.type === 'open-pane') go(paneView(d.pane))
    }
    navigator.serviceWorker?.addEventListener('message', onSw)
    boot(route.view.kind === 'pane' ? route.view.pane : undefined).then((got) => {
      booted = true
      // 地址里没有 pane、或者那个 pane 已经没了：改成实际打开的那个（不新增历史）
      const v = route.view
      if (got && (v.kind === 'none' || (v.kind === 'pane' && v.pane !== got))) navigate({ view: paneView(got), sheet: route.sheet, open: route.open }, { replace: true })
    })
    navigator.serviceWorker?.ready.then(() => pushStatus()).then((v) => (pushOn = v), () => {})
    return () => {
      window.visualViewport?.removeEventListener('resize', fitViewport)
      window.removeEventListener('resize', fitViewport)
      navigator.serviceWorker?.removeEventListener('message', onSw)
    }
  })

  // 手动重连：点状态圆点或断线提示条上的「重连」
  let reconnecting = $state(false)
  async function reconnect() {
    if (reconnecting) return
    reconnecting = true
    const { dropped, mac } = await reconnectPane()
    reconnecting = false
    if (ui.current) refreshCrons(true)
    const notes = [dropped ? t('丢掉了 {n} 个卡住没发出去的输入', { n: dropped }) : '', mac.startsWith('reset') ? (mac.includes('→ ok') ? t('电脑连接重建：已恢复') : t('电脑连接重建：还是连不上')) : mac && mac !== 'ok' ? t('服务端：{msg}', { msg: tr(mac) }) : '']
    toast(t('已重连'), { description: notes.filter(Boolean).join(t('；')) || undefined })
  }

  function openCreate(t: CreateTarget) {
    createTarget = t
    sessionsSheet.set(false)
    createOpen = true
  }

  const iconBtn = 'grid h-8 min-w-9 place-items-center rounded-lg px-1.5 text-[13px] text-muted-foreground active:bg-accent'
</script>

<!-- sticky：新版 iOS 的主屏幕网页 App 会在顶部叠一层半透明渐隐（Safari 网页里没有），压在顶栏上发白。
     顶部是 fixed / sticky 元素时 Safari 改用它的底色填充，不再叠渐隐。页面本身不滚动，sticky 对布局没有影响 -->
<!-- 顶栏只有：连接状态点、当前会话名（点开会话列表）、问题 / 待办徽标、更多菜单 -->
<header class="sticky top-0 z-30 flex items-center gap-2 border-b bg-card px-3 pt-[calc(env(safe-area-inset-top)+6px)] pb-1.5">
  {#if update.available}
    <button class="flex-none rounded-full bg-primary px-2.5 text-[12px] leading-6 font-semibold text-primary-foreground active:opacity-80" onclick={() => location.reload()}>{t('更新')}</button>
  {/if}
  {#if view.kind === 'cursor'}
    <button class="-mr-2 grid size-8 flex-none place-items-center rounded-lg active:bg-accent" aria-label={t('重连 Cursor（{msg}）', { msg: tr(cur.msg) })} onclick={() => { reconnectCursor(); toast(t('重连 Cursor…')) }}>
      <span class={cn('size-2 rounded-full', cur.conn === 'ready' ? 'bg-ok' : cur.conn === 'error' ? 'bg-destructive' : 'bg-muted-foreground', cur.generating && 'animate-pulse bg-primary')}></span>
    </button>
  {:else if !plugin}
    <button class="-mr-2 grid size-8 flex-none place-items-center rounded-lg active:bg-accent" aria-label={t('重连（{msg}）', { msg: ui.statusMsg })} title={t('点一下手动重连')} onclick={reconnect}>
      <span class={cn('size-2 rounded-full bg-muted-foreground', ui.status === 'live' && 'bg-ok', ui.status === 'err' && 'bg-destructive', reconnecting && 'animate-ping bg-primary')}></span>
    </button>
  {/if}
  <button class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left" aria-haspopup="dialog" data-testid="session-title" onclick={() => openSheet('sessions')}>
    {#if view.kind === 'cursor'}<CursorIcon class="size-4 flex-none" />{:else if plugin}<PluginsIcon class="size-4 flex-none" />{/if}
    <span class="min-w-0 truncate font-semibold">{source ? source.title() : pluginInfo(plugin)?.name || t('插件 · {id}', { id: plugin })}</span>
    <ChevronDown class="size-4 flex-none text-muted-foreground" />
  </button>
  {#if incidents.open}
    <button class="flex flex-none items-center gap-1 rounded-full bg-destructive/90 px-2 text-[11px] leading-5 font-semibold text-white" title={t('pane-remote 发现的问题')} onclick={() => openIncident()}><TriangleAlert class="size-3" />{incidents.open}</button>
  {/if}
  {#if waiting}
    <button class="flex-none rounded-full bg-warn px-2 text-[11px] leading-5 font-semibold text-black" title={t('别的 pane / Cursor 会话在等你操作')} onclick={() => openSheet('inbox')}>{t('{n} 待办', { n: waiting })}</button>
  {/if}
  {#if moreLoaded}
    {#await import('$lib/components/MoreMenu.svelte') then M}
      <M.default bind:open={moreOpen} class={iconBtn} {onPane} {pushOn}
        onplugins={() => (plugins.drawer = true)} onreader={() => (readerOpen = true)}
        onwidth={() => openWidth(ui.panes.find((p) => String(p.pane) === ui.current))} onincident={() => openIncident()} onnotify={() => (notifOpen = true)} />
    {/await}
  {:else}
    <!-- 菜单第一次点开时才下载（MoreMenu），之前是一个样子一样的按钮 -->
    <button class={cn(iconBtn, 'relative')} aria-label={t('更多：阅读、字号、通知、语言')} onclick={() => { moreLoaded = true; moreOpen = true }}><Ellipsis class="size-4" /></button>
  {/if}
</header>

{#if onPane}
  {#if ui.status === 'err' && ui.hasFrame}
    <div class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
      <span class="min-w-0 flex-1">{ui.statusMsg}</span>
      <button class="flex-none rounded-md border border-destructive/40 px-2 py-0.5 font-medium active:bg-destructive/20" onclick={reconnect}>{t('重连')}</button>
    </div>
  {/if}

  {#if ui.claude}
    <!-- 会话栏（有 agent 会话的 pane）：对话 / 原始画面切换和会话操作 -->
    <div class="flex h-10 flex-none items-center gap-2 border-b bg-card px-2.5" data-testid="session-bar">
      <!-- 窄屏（iPhone SE、英文界面）放不下：切换按钮和右边的按钮不缩、不折行，只有模型芯片缩（截断）；分叉、会话按钮在窄屏只留图标 -->
      <div class="flex flex-none rounded-lg bg-secondary p-0.5 text-[13px] whitespace-nowrap">
        <button class={cn('h-7 rounded-md px-3', termView === 'chat' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('chat')}>{t('对话')}</button>
        <button class={cn('h-7 rounded-md px-3', termView === 'term' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('term')}>{t('原始画面')}</button>
      </div>
      <ModelChip pane={ui.current ?? ''} />
      <span class="flex-1"></span>
      {#if cronTasks.length}
        <button class="relative flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2.5 text-[13px] whitespace-nowrap active:bg-accent" aria-label={t('定时任务')} onclick={() => (cronOpen = true)}>
          <Clock class="size-3.5 text-muted-foreground" />{t('定时 {n}', { n: cronTasks.length })}
          {#if cronTasks.some((t) => t.last?.running)}<span class="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-primary"></span>{/if}
        </button>
      {/if}
      {#if ui.claude.agent !== 'cursor-agent'}
        <button class="flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2.5 text-[13px] whitespace-nowrap active:bg-accent" aria-label={t('分叉当前会话')} onclick={() => (claudeOpen = true)}>
          <GitFork class="size-3.5 text-primary" /><span class="max-[419px]:hidden">{t('分叉')}</span>
        </button>
      {/if}
      <button class="flex h-8 flex-none items-center gap-1.5 rounded-lg border px-2.5 text-[13px] whitespace-nowrap active:bg-accent" aria-label={t('会话')} onclick={() => (claudeOpen = true)}>
        <Sparkles class="size-3.5 text-primary" /><span class="max-[419px]:hidden">{t('会话')}</span>
      </button>
    </div>
  {/if}
  {#if chatMode}
    {#await ChatView() then M}<M.default onpreview={previewUrl} />{/await}
  {:else if viewReady}
    {#await TerminalView() then M}<M.default {viewportTick} onpreview={previewUrl} />{/await}
  {:else}
    <div class="min-h-0 flex-1"></div>
  {/if}

  <div bind:this={dock} class="border-t bg-card pb-[env(safe-area-inset-bottom)]">
    <PromptBar />
    <AgentFocusBar />
    <DraftBar chat={chatMode} />
    <!-- 快捷键是给终端设计的：对话模式下不显示 -->
    {#if !chatMode}<KeyBar bind:ctrl onedit={() => (keysOpen = true)} />{/if}
    <Composer bind:ctrl chat={chatMode} onresize={fitViewport} />
  </div>
{:else if view.kind === 'cursor'}
  {#await CursorView() then M}<M.default onpreview={previewUrl} onpick={() => openSheet('sessions')} />{/await}
{:else}
  <!-- 插件（含自带的预览、这台电脑、看屏幕）：插件层（PluginLayer）在前台打开它、盖在上面；这里只在载入中 / 找不到时显示 -->
  <PluginRoute id={plugin} onpick={() => openSheet('sessions')} />
{/if}

<PaneSheet bind:open={sessionsSheet.get, sessionsSheet.set} onreconnect={reconnect} onactions={(p) => { actPane = p; sessionsSheet.set(false); actOpen = true }} oncreate={openCreate} />
{#if once.act}
  {#await import('$lib/components/PaneActions.svelte') then M}
    <M.default
      bind:open={actOpen}
      pane={actPane}
      onopen={() => sessionsSheet.set(false)}
      onsplit={(p, direction) => openCreate({ split: p, direction, dir: p.dir })}
      onrename={() => (renameOpen = true)}
      onwidth={(p) => openWidth(p)}
    />
  {/await}
{/if}
{#if once.width}{#await import('$lib/components/WidthSheet.svelte') then M}<M.default bind:open={widthOpen} pane={widthPane} />{/await}{/if}
{#if once.create}{#await import('$lib/components/CreatePane.svelte') then M}<M.default bind:open={createOpen} target={createTarget} ondone={() => sessionsSheet.set(false)} />{/await}{/if}
{#if once.rename}{#await import('$lib/components/RenameSheet.svelte') then M}<M.default bind:open={renameOpen} pane={actPane} />{/await}{/if}
{#if once.notif}{#await import('$lib/components/NotifySheet.svelte') then M}<M.default bind:open={notifOpen} bind:on={pushOn} />{/await}{/if}
{#if once.keys}{#await import('$lib/components/KeyEditor.svelte') then M}<M.default bind:open={keysOpen} />{/await}{/if}
{#if once.inbox}{#await import('$lib/components/Inbox.svelte') then M}<M.default bind:open={inboxSheet.get, inboxSheet.set} oncursor={openCursorSession} />{/await}{/if}
<AgentAsk />
{#if once.incident}{#await import('$lib/components/IncidentSheet.svelte') then M}<M.default bind:open={incidentSheet.get, incidentSheet.set} />{/await}{/if}
{#if once.claude}{#await import('$lib/claude/ClaudeSheet.svelte') then M}<M.default bind:open={claudeOpen} />{/await}{/if}
{#if once.cron}{#await import('$lib/claude/CronSheet.svelte') then M}<M.default bind:open={cronOpen} />{/await}{/if}
{#if once.reader}{#await import('$lib/components/Reader.svelte') then M}<M.default bind:open={readerOpen} onpreview={() => go(pluginView('preview'))} />{/await}{/if}
<!-- 提示层避开 iPhone 的刘海 / 状态栏，并放在顶栏下面（不挡顶栏的按钮）；带关闭按钮，任何提示都能随手关掉 -->
<Toaster theme="system" position="top-center" closeButton offset={{ top: 'calc(env(safe-area-inset-top) + 52px)' }} mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 52px)' }} />
<!-- 插件层：全局悬浮按钮 + 插件抽屉 / 容器（插件开在前台时盖住整个外壳，#/plugin/<id> 和它双向同步） -->
<PluginLayer />
<!-- 被顶 / 在被遥控的电脑上打开：盖住一切 -->
<LeaseGate />
