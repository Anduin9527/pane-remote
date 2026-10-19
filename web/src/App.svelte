<script lang="ts">
  import { onMount } from 'svelte'
  import { Toaster } from '$lib/components/ui/sonner'
  import { toast } from 'svelte-sonner'
  import Bell from '@lucide/svelte/icons/bell'
  import BellOff from '@lucide/svelte/icons/bell-off'
  import MoveHorizontal from '@lucide/svelte/icons/move-horizontal'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import TerminalView from '$lib/term/TerminalView.svelte'
  import KeyBar from '$lib/components/KeyBar.svelte'
  import Composer from '$lib/components/Composer.svelte'
  import PaneSheet from '$lib/components/PaneSheet.svelte'
  import PaneActions from '$lib/components/PaneActions.svelte'
  import WidthSheet from '$lib/components/WidthSheet.svelte'
  import CreatePane from '$lib/components/CreatePane.svelte'
  import RenameSheet from '$lib/components/RenameSheet.svelte'
  import NotifySheet from '$lib/components/NotifySheet.svelte'
  import PromptBar from '$lib/components/PromptBar.svelte'
  import KeyEditor from '$lib/components/KeyEditor.svelte'
  import PreviewView from '$lib/preview/PreviewView.svelte'
  import CursorView from '$lib/cursor/CursorView.svelte'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'
  import { selectSession as selectCursorSession, cursorSummary } from '$lib/cursor/cursor.svelte'
  import Inbox from '$lib/components/Inbox.svelte'
  import Reader from '$lib/components/Reader.svelte'
  import FileText from '@lucide/svelte/icons/file-text'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Languages from '@lucide/svelte/icons/languages'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import GitFork from '@lucide/svelte/icons/git-fork'
  import ChatView from '$lib/claude/ChatView.svelte'
  import ClaudeSheet from '$lib/claude/ClaudeSheet.svelte'
  import CronSheet from '$lib/claude/CronSheet.svelte'
  import Clock from '@lucide/svelte/icons/alarm-clock'
  import { crons, refreshCrons } from '$lib/claude/crons.svelte'
  import DraftBar from '$lib/components/DraftBar.svelte'
  import AgentFocusBar from '$lib/components/AgentFocusBar.svelte'
  import Terminal from '@lucide/svelte/icons/square-terminal'
  import Globe from '@lucide/svelte/icons/globe'
  import Monitor from '@lucide/svelte/icons/monitor'
  import { onSendError, type CreateTarget, type Pane } from '$lib/api'
  import { prefs } from '$lib/prefs.svelte'
  import { pushStatus } from '$lib/push'
  import { ui, boot, loadPanes, paneName, select, setStatus, waitingElsewhere, setPaused, onOpenUrl, reconnectPane } from '$lib/session.svelte'
  import { openInPreview, previewUi } from '$lib/preview/request.svelte'
  import { update } from '$lib/update.svelte'
  import { appConfig, loadAppConfig } from '$lib/appConfig.svelte'
  import { cn } from '$lib/utils'
  import { t, tr, isEn, setLang } from '$lib/i18n'

  let ctrl = $state(false)
  let pickOpen = $state(false)
  let actOpen = $state(false)
  let createOpen = $state(false)
  let renameOpen = $state(false)
  let notifOpen = $state(false)
  let keysOpen = $state(false)
  let inboxOpen = $state(false)
  let claudeOpen = $state(false)
  let cronOpen = $state(false)
  // 看屏幕模块：全屏盖在最上面，不算一个视图（关掉回到原来的页面）；noVNC 比较大，打开时才加载
  let screenOpen = $state(false)
  let ScreenView = $state<typeof import('$lib/screen/ScreenView.svelte').default | null>(null)
  async function openScreen() {
    try { ScreenView ??= (await import('$lib/screen/ScreenView.svelte')).default } catch { toast.error(t('屏幕加载失败，刷新页面再试')); return }
    screenOpen = true
  }
  // 切到 Claude 会话的 pane 时读一下它的定时任务：有任务才在会话栏显示入口
  $effect(() => { if (ui.current && ui.claude?.agent === 'claude' && ui.claude.session) refreshCrons() })
  const cronTasks = $derived(crons.pane === ui.current && ui.claude?.agent === 'claude' ? crons.data?.tasks ?? [] : [])
  // Claude 会话的 pane：终端画面 / 对话视图，每个 pane 各自记住（存在手机本地）。没设置过的默认终端。
  let termViews = $state<Record<string, 'term' | 'chat'>>((() => { try { return JSON.parse(localStorage.getItem('termViews') || '{}') } catch { return {} } })())
  $effect(() => { try { localStorage.setItem('termViews', JSON.stringify($state.snapshot(termViews))) } catch {} })
  const termView = $derived((ui.current && termViews[ui.current]) || 'term')
  const setView = (v: 'term' | 'chat') => { if (ui.current) termViews[ui.current] = v }
  const chatMode = $derived(!!ui.claude && termView === 'chat')
  let readerOpen = $state(false)
  // 待办：等你操作的 pane + 等你操作的 Cursor 会话（开了 Cursor 模块时）
  const cursorWaiting = () => (appConfig.modules.cursor ? cursorSummary.waiting.length : 0)
  const waitingAll = () => Object.values(ui.states).filter((s) => s.state === 'waiting').length + cursorWaiting()
  const waitingOthers = () => waitingElsewhere() + cursorWaiting()
  // 终端 / 预览 两个视图，记住上次停在哪个
  let mode = $state<'term' | 'preview' | 'cursor'>((() => { try { const m = localStorage.getItem('mode'); return m === 'preview' || m === 'cursor' ? m : 'term' } catch { return 'term' } })())
  $effect(() => { try { localStorage.setItem('mode', mode) } catch {} })
  // 在预览页时断开终端画面流：服务端据此知道你没在看那个 pane，该推的通知照推
  $effect(() => { setPaused(mode !== 'term') })
  // 服务端没开 Cursor 模块：不显示 Cursor 入口
  $effect(() => { if (appConfig.loaded && !appConfig.modules.cursor && mode === 'cursor') mode = 'term' })
  // 服务端没开预览模块：不显示预览入口
  $effect(() => { if (appConfig.loaded && !appConfig.modules.preview && mode === 'preview') mode = 'term' })
  let pushOn = $state(false)
  let actPane = $state<Pane | null>(null)
  let widthOpen = $state(false)
  let widthPane = $state<Pane | null>(null)
  function openWidth(p: Pane | null | undefined) { if (p) { widthPane = p; widthOpen = true } }
  let createTarget = $state<CreateTarget>({})
  let viewportTick = $state(0)
  let dock = $state<HTMLDivElement>()

  // 状态条会被下一帧画面刷回「已连接」，发送失败另外弹一条提示，免得没看到
  onSendError((msg) => { setStatus('err', msg); toast.error(msg, { id: 'send-error' }) })

  // 电脑要打开网页：切到预览页打开
  function previewUrl(url: string) {
    // 没开预览模块：网址直接在手机浏览器里开（本机地址、文件手机上打不开，就算了）
    if (appConfig.loaded && !appConfig.modules.preview) {
      if (/^https?:\/\//.test(url) && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(url)) window.open(url, '_blank', 'noopener')
      else toast(t('预览模块没开，电脑上的地址和文件在手机上打不开'), { description: url })
      return
    }
    openInPreview(url)
    mode = 'preview'
  }
  onOpenUrl((url) => {
    toast(t('电脑要打开一个网页'), { description: url, duration: 10000, action: { label: t('在预览中打开'), onClick: () => previewUrl(url) } })
  })
  // 从 Cursor 的通知点进来会带 ?cursor=会话
  {
    const c = new URLSearchParams(location.search).get('cursor')
    if (c && /^[0-9a-f-]{8,64}$/i.test(c)) { selectCursorSession(c); mode = 'cursor'; history.replaceState(null, '', location.pathname) }
  }
  // 从「电脑要打开网页」的通知点进来会带 ?preview=…。这个地址谁都能构造（别的网页可以链接过来），
  // 所以不直接打开，要你点一下确认：预览浏览器跑在电脑上，能访问电脑的本机服务和内网
  {
    const q = new URLSearchParams(location.search).get('preview')
    if (q) {
      history.replaceState(null, '', location.pathname)
      setTimeout(() => toast(t('要在预览里打开这个网页吗？'), { description: q.slice(0, 300), duration: 15000, action: { label: t('打开'), onClick: () => previewUrl(q) } }), 600)
    }
  }

  // 视口：iOS 键盘弹出时可视高度变小，把整页高度设成可视高度，底栏跟着顶上来
  function fitViewport() {
    const vv = window.visualViewport
    const root = document.documentElement.style
    root.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`)
    if (dock) root.setProperty('--dock-h', `${dock.offsetHeight}px`)
    if (vv) window.scrollTo(0, 0)
    viewportTick++
  }

  onMount(() => {
    fitViewport()
    window.visualViewport?.addEventListener('resize', fitViewport)
    window.addEventListener('resize', fitViewport)
    const onSw = (e: MessageEvent) => {
      if (e.data?.type === 'open-preview') return previewUrl(e.data.url)
      if (e.data?.type === 'open-cursor') { selectCursorSession(e.data.id); mode = 'cursor'; return }
      if (e.data?.type === 'open-pane') loadPanes().catch(() => {}).finally(() => select(e.data.pane))
    }
    navigator.serviceWorker?.addEventListener('message', onSw)
    boot()
    loadAppConfig()
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

  function zoom(d: number) {
    prefs.fit = false
    prefs.fs = Math.min(22, Math.max(6, Math.round(prefs.fs) + d))
  }
  function openCreate(t: CreateTarget) {
    createTarget = t
    pickOpen = false
    createOpen = true
  }

  const iconBtn = 'grid h-8 min-w-9 place-items-center rounded-lg px-1.5 text-[13px] text-muted-foreground active:bg-accent'
</script>

{#if !(mode === 'preview' && previewUi.immersive)}
<!-- sticky：新版 iOS 的主屏幕网页 App 会在顶部叠一层半透明渐隐（Safari 网页里没有），压在顶栏上发白。
     顶部是 fixed / sticky 元素时 Safari 改用它的底色填充，不再叠渐隐。页面本身不滚动，sticky 对布局没有影响 -->
<header class="sticky top-0 z-30 flex items-center gap-2 border-b bg-card px-3 pt-[calc(env(safe-area-inset-top)+6px)] pb-1.5">
  <div class="flex flex-none rounded-lg bg-secondary p-0.5">
    <button class={cn('grid h-7 w-8 place-items-center rounded-md text-muted-foreground', mode === 'term' && 'bg-card text-foreground shadow-sm')} aria-label={t('终端')} aria-pressed={mode === 'term'} onclick={() => (mode = 'term')}><Terminal class="size-4" /></button>
    {#if appConfig.modules.preview}
      <button class={cn('grid h-7 w-8 place-items-center rounded-md text-muted-foreground', mode === 'preview' && 'bg-card text-foreground shadow-sm')} aria-label={t('预览')} aria-pressed={mode === 'preview'} onclick={() => (mode = 'preview')}><Globe class="size-4" /></button>
    {/if}
    {#if appConfig.modules.cursor}
      <button class={cn('grid h-7 w-8 place-items-center rounded-md text-muted-foreground', mode === 'cursor' && 'bg-card text-foreground shadow-sm')} aria-label="Cursor" aria-pressed={mode === 'cursor'} onclick={() => (mode = 'cursor')}><span class="relative"><CursorIcon class="size-4" />{#if mode !== 'cursor' && (cursorSummary.waiting.length || cursorSummary.unread)}<span class={cn('absolute -top-1 -right-1.5 size-2 rounded-full ring-2 ring-secondary', cursorSummary.waiting.length ? 'bg-warn' : 'bg-primary')}></span>{/if}</span></button>
    {/if}
    {#if appConfig.modules.screen}
      <button class="grid h-7 w-8 place-items-center rounded-md text-muted-foreground" aria-label={t('看电脑屏幕')} onclick={openScreen}><Monitor class="size-4" /></button>
    {/if}
  </div>
  {#if update.available}
    <button class="flex-none rounded-full bg-primary px-2.5 text-[12px] leading-6 font-semibold text-primary-foreground active:opacity-80" onclick={() => location.reload()}>{t('更新')}</button>
  {/if}
  {#if mode === 'term'}
    <button class="-mr-2 grid size-8 flex-none place-items-center rounded-lg active:bg-accent" aria-label={t('重连（{msg}）', { msg: ui.statusMsg })} title={t('点一下手动重连')} onclick={reconnect}>
      <span class={cn('size-2 rounded-full bg-muted-foreground', ui.status === 'live' && 'bg-ok', ui.status === 'err' && 'bg-destructive', reconnecting && 'animate-ping bg-primary')}></span>
    </button>
    <button class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left" aria-haspopup="dialog" onclick={() => (pickOpen = true)}>
      <span class="min-w-0 truncate font-semibold">{paneName()}</span>
      <ChevronDown class="size-4 flex-none text-muted-foreground" />
    </button>
    {#if waitingOthers()}
      <button class="flex-none rounded-full bg-warn px-2 text-[11px] leading-5 font-semibold text-black" title={t('别的 pane / Cursor 会话在等你操作')} onclick={() => (inboxOpen = true)}>{t('{n} 待办', { n: waitingOthers() })}</button>
    {/if}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class={iconBtn} aria-label={t('更多：阅读、字号、通知、语言')}>
        <Ellipsis class="size-4" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-64">
        <DropdownMenu.Item onSelect={() => (readerOpen = true)}><FileText />{t('阅读模式')}<span class="ml-auto text-xs text-muted-foreground">{t('复制、搜索、链接')}</span></DropdownMenu.Item>
        <div class="flex items-center gap-1.5 px-1.5 py-1 text-sm">
          <span class="flex-1">{t('字号 {n}', { n: prefs.fs })}</span>
          <button class="h-7 w-9 rounded-md border active:bg-accent" aria-label={t('缩小字号')} onclick={() => zoom(-1)}>A−</button>
          <button class="h-7 w-9 rounded-md border active:bg-accent" aria-label={t('放大字号')} onclick={() => zoom(1)}>A+</button>
        </div>
        <DropdownMenu.Item onSelect={(e) => { e.preventDefault(); prefs.fit = !prefs.fit }}><MoveHorizontal />{t('适配屏幕宽度')}<span class="ml-auto text-xs {prefs.fit ? 'text-ok' : 'text-muted-foreground'}">{prefs.fit ? t('开') : t('关')}</span></DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => openWidth(ui.panes.find((p) => String(p.pane) === ui.current))}><Columns3 />{t('电脑上的宽度')}<span class="ml-auto text-xs text-muted-foreground">{t('{n} 列', { n: ui.cols })}</span></DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => (notifOpen = true)}>{#if pushOn}<Bell />{:else}<BellOff />{/if}{t('推送通知')}<span class="ml-auto text-xs text-muted-foreground">{pushOn ? t('已开') : t('未开')}</span></DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => setLang(isEn ? 'zh' : 'en')}><Languages />{t('语言')}<span class="ml-auto text-xs text-muted-foreground">{isEn ? 'English → 中文' : '中文 → English'}</span></DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {:else}
    <span class="min-w-0 flex-1 truncate font-semibold">{mode === 'cursor' ? t('Cursor · 电脑上的 IDE') : t('预览 · 电脑上的浏览器')}</span>
    {#if waitingAll()}
      <button class="flex-none rounded-full bg-warn px-2 text-[11px] leading-5 font-semibold text-black" onclick={() => (inboxOpen = true)}>{t('{n} 待办', { n: waitingAll() })}</button>
    {/if}
  {/if}
</header>
{/if}

{#if mode === 'term'}
  {#if ui.status === 'err' && ui.hasFrame}
    <div class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
      <span class="min-w-0 flex-1">{ui.statusMsg}</span>
      <button class="flex-none rounded-md border border-destructive/40 px-2 py-0.5 font-medium active:bg-destructive/20" onclick={reconnect}>{t('重连')}</button>
    </div>
  {/if}

  {#if ui.claude}
    <div class="flex h-10 flex-none items-center gap-2 border-b bg-card px-2.5">
      <div class="flex rounded-lg bg-secondary p-0.5 text-[13px]">
        <button class={cn('h-7 rounded-md px-3', termView === 'chat' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('chat')}>{t('对话')}</button>
        <button class={cn('h-7 rounded-md px-3', termView === 'term' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('term')}>{t('终端')}</button>
      </div>
      <span class="flex-1"></span>
      {#if cronTasks.length}
        <button class="relative flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" aria-label={t('定时任务')} onclick={() => (cronOpen = true)}>
          <Clock class="size-3.5 text-muted-foreground" />{t('定时 {n}', { n: cronTasks.length })}
          {#if cronTasks.some((t) => t.last?.running)}<span class="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-primary"></span>{/if}
        </button>
      {/if}
      {#if ui.claude.agent !== 'cursor-agent'}
        <button class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" aria-label={t('分叉当前会话')} onclick={() => (claudeOpen = true)}>
          <GitFork class="size-3.5 text-primary" />{t('分叉')}
        </button>
      {/if}
      <button class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" onclick={() => (claudeOpen = true)}>
        <Sparkles class="size-3.5 text-primary" />{t('会话')}
      </button>
    </div>
  {/if}
  {#if chatMode}
    <ChatView onpreview={previewUrl} />
  {:else}
    <TerminalView {viewportTick} onpreview={previewUrl} />
  {/if}

  <div bind:this={dock} class="border-t bg-card pb-[env(safe-area-inset-bottom)]">
    <PromptBar />
    <AgentFocusBar />
    <DraftBar chat={chatMode} />
    <!-- 快捷键是给终端设计的：对话模式下不显示 -->
    {#if !chatMode}<KeyBar bind:ctrl onedit={() => (keysOpen = true)} />{/if}
    <Composer bind:ctrl chat={chatMode} onresize={fitViewport} />
  </div>
{:else if mode === 'cursor'}
  <CursorView onpreview={previewUrl} />
{:else}
  <PreviewView />
{/if}

<PaneSheet bind:open={pickOpen} onreconnect={reconnect} onactions={(p) => { actPane = p; pickOpen = false; actOpen = true }} oncreate={openCreate} />
<PaneActions
  bind:open={actOpen}
  pane={actPane}
  onopen={() => (pickOpen = false)}
  onsplit={(p, direction) => openCreate({ split: p, direction, dir: p.dir })}
  onrename={() => (renameOpen = true)}
  onwidth={(p) => openWidth(p)}
/>
<WidthSheet bind:open={widthOpen} pane={widthPane} />
<CreatePane bind:open={createOpen} target={createTarget} ondone={() => (pickOpen = false)} />
<RenameSheet bind:open={renameOpen} pane={actPane} />
<NotifySheet bind:open={notifOpen} bind:on={pushOn} />
<KeyEditor bind:open={keysOpen} />
<Inbox bind:open={inboxOpen} oncursor={(id) => { selectCursorSession(id); mode = 'cursor' }} />
<ClaudeSheet bind:open={claudeOpen} />
<CronSheet bind:open={cronOpen} />
<Reader bind:open={readerOpen} onpreview={() => (mode = 'preview')} />
{#if ScreenView && appConfig.modules.screen}
  <ScreenView bind:open={screenOpen} />
{/if}
<!-- 提示层避开 iPhone 的刘海 / 状态栏，并放在顶栏下面（不挡顶栏的按钮）；带关闭按钮，任何提示都能随手关掉 -->
<Toaster theme="system" position="top-center" closeButton offset={{ top: 'calc(env(safe-area-inset-top) + 52px)' }} mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 52px)' }} />
