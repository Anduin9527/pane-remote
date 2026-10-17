<script lang="ts">
  import { onMount } from 'svelte'
  import { Toaster } from '$lib/components/ui/sonner'
  import { toast } from 'svelte-sonner'
  import Bell from '@lucide/svelte/icons/bell'
  import BellOff from '@lucide/svelte/icons/bell-off'
  import MoveHorizontal from '@lucide/svelte/icons/move-horizontal'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import TerminalView from '$lib/term/TerminalView.svelte'
  import KeyBar from '$lib/components/KeyBar.svelte'
  import Composer from '$lib/components/Composer.svelte'
  import PaneSheet from '$lib/components/PaneSheet.svelte'
  import PaneActions from '$lib/components/PaneActions.svelte'
  import CreatePane from '$lib/components/CreatePane.svelte'
  import RenameSheet from '$lib/components/RenameSheet.svelte'
  import NotifySheet from '$lib/components/NotifySheet.svelte'
  import PromptBar from '$lib/components/PromptBar.svelte'
  import KeyEditor from '$lib/components/KeyEditor.svelte'
  import PreviewView from '$lib/preview/PreviewView.svelte'
  import Inbox from '$lib/components/Inbox.svelte'
  import Reader from '$lib/components/Reader.svelte'
  import FileText from '@lucide/svelte/icons/file-text'
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
  import { onSendError, type CreateTarget, type Pane } from '$lib/api'
  import { prefs } from '$lib/prefs.svelte'
  import { pushStatus } from '$lib/push'
  import { ui, boot, loadPanes, paneName, select, setStatus, waitingElsewhere, setPaused, onOpenUrl, reconnectPane } from '$lib/session.svelte'
  import { openInPreview, previewUi } from '$lib/preview/request.svelte'
  import { appConfig, loadAppConfig } from '$lib/appConfig.svelte'
  import { cn } from '$lib/utils'

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
  const waitingAll = () => Object.values(ui.states).filter((s) => s.state === 'waiting').length
  // 终端 / 预览 两个视图，记住上次停在哪个
  let mode = $state<'term' | 'preview'>((() => { try { return localStorage.getItem('mode') === 'preview' ? 'preview' : 'term' } catch { return 'term' } })())
  $effect(() => { try { localStorage.setItem('mode', mode) } catch {} })
  // 在预览页时断开终端画面流：服务端据此知道你没在看那个 pane，该推的通知照推
  $effect(() => { setPaused(mode === 'preview') })
  // 服务端没开预览模块：不显示预览入口
  $effect(() => { if (appConfig.loaded && !appConfig.modules.preview && mode === 'preview') mode = 'term' })
  let pushOn = $state(false)
  let actPane = $state<Pane | null>(null)
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
      else toast('预览模块没开，电脑上的地址和文件在手机上打不开', { description: url })
      return
    }
    openInPreview(url)
    mode = 'preview'
  }
  onOpenUrl((url) => {
    toast('电脑要打开一个网页', { description: url, duration: 10000, action: { label: '在预览中打开', onClick: () => previewUrl(url) } })
  })
  // 从「电脑要打开网页」的通知点进来会带 ?preview=…。这个地址谁都能构造（别的网页可以链接过来），
  // 所以不直接打开，要你点一下确认：预览浏览器跑在电脑上，能访问电脑的本机服务和内网
  {
    const q = new URLSearchParams(location.search).get('preview')
    if (q) {
      history.replaceState(null, '', location.pathname)
      setTimeout(() => toast('要在预览里打开这个网页吗？', { description: q.slice(0, 300), duration: 15000, action: { label: '打开', onClick: () => previewUrl(q) } }), 600)
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
    const notes = [dropped ? `丢掉了 ${dropped} 个卡住没发出去的输入` : '', mac.startsWith('reset') ? `电脑连接重建：${mac.includes('→ ok') ? '已恢复' : '还是连不上'}` : mac && mac !== 'ok' ? `服务端：${mac}` : '']
    toast('已重连', { description: notes.filter(Boolean).join('；') || undefined })
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
<header class="flex items-center gap-2 border-b bg-card px-3 pt-[calc(env(safe-area-inset-top)+6px)] pb-1.5">
  <div class="flex flex-none rounded-lg bg-secondary p-0.5">
    <button class={cn('grid h-7 w-8 place-items-center rounded-md text-muted-foreground', mode === 'term' && 'bg-card text-foreground shadow-sm')} aria-label="终端" aria-pressed={mode === 'term'} onclick={() => (mode = 'term')}><Terminal class="size-4" /></button>
    {#if appConfig.modules.preview}
      <button class={cn('grid h-7 w-8 place-items-center rounded-md text-muted-foreground', mode === 'preview' && 'bg-card text-foreground shadow-sm')} aria-label="预览" aria-pressed={mode === 'preview'} onclick={() => (mode = 'preview')}><Globe class="size-4" /></button>
    {/if}
  </div>
  {#if mode === 'term'}
    <button class="-mr-2 grid size-8 flex-none place-items-center rounded-lg active:bg-accent" aria-label="重连（{ui.statusMsg}）" title="点一下手动重连" onclick={reconnect}>
      <span class={cn('size-2 rounded-full bg-muted-foreground', ui.status === 'live' && 'bg-ok', ui.status === 'err' && 'bg-destructive', reconnecting && 'animate-ping bg-primary')}></span>
    </button>
    <button class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left" aria-haspopup="dialog" onclick={() => (pickOpen = true)}>
      <span class="min-w-0 truncate font-semibold">{paneName()}</span>
      <ChevronDown class="size-4 flex-none text-muted-foreground" />
    </button>
    {#if waitingElsewhere()}
      <button class="flex-none rounded-full bg-warn px-2 text-[11px] leading-5 font-semibold text-black" title="别的 pane 在等你操作" onclick={() => (inboxOpen = true)}>{waitingElsewhere()} 待办</button>
    {/if}
    <div class="flex gap-0.5">
      <button class={iconBtn} aria-label="阅读模式（复制、搜索、打开链接）" onclick={() => (readerOpen = true)}><FileText class="size-4" /></button>
      <button class={iconBtn} aria-label="缩小字号" onclick={() => zoom(-1)}>A−</button>
      <button class={iconBtn} aria-label="放大字号" onclick={() => zoom(1)}>A+</button>
      <button class={cn(iconBtn, pushOn && 'text-foreground')} aria-label="推送通知" aria-pressed={pushOn} onclick={() => (notifOpen = true)}>
        {#if pushOn}<Bell class="size-4" />{:else}<BellOff class="size-4" />{/if}
      </button>
      <button class={cn(iconBtn, prefs.fit && 'bg-accent text-foreground')} aria-label="适配屏幕宽度" aria-pressed={prefs.fit} onclick={() => (prefs.fit = !prefs.fit)}>
        <MoveHorizontal class="size-4" />
      </button>
    </div>
  {:else}
    <span class="min-w-0 flex-1 truncate font-semibold">预览 · 电脑上的浏览器</span>
    {#if waitingAll()}
      <button class="flex-none rounded-full bg-warn px-2 text-[11px] leading-5 font-semibold text-black" onclick={() => (inboxOpen = true)}>{waitingAll()} 待办</button>
    {/if}
  {/if}
</header>
{/if}

{#if mode === 'term'}
  {#if ui.status === 'err' && ui.hasFrame}
    <div class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-xs text-destructive">
      <span class="min-w-0 flex-1">{ui.statusMsg}</span>
      <button class="flex-none rounded-md border border-destructive/40 px-2 py-0.5 font-medium active:bg-destructive/20" onclick={reconnect}>重连</button>
    </div>
  {/if}

  {#if ui.claude}
    <div class="flex h-10 flex-none items-center gap-2 border-b bg-card px-2.5">
      <div class="flex rounded-lg bg-secondary p-0.5 text-[13px]">
        <button class={cn('h-7 rounded-md px-3', termView === 'chat' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('chat')}>对话</button>
        <button class={cn('h-7 rounded-md px-3', termView === 'term' ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')} onclick={() => setView('term')}>终端</button>
      </div>
      <span class="flex-1"></span>
      {#if cronTasks.length}
        <button class="relative flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" aria-label="定时任务" onclick={() => (cronOpen = true)}>
          <Clock class="size-3.5 text-muted-foreground" />定时 {cronTasks.length}
          {#if cronTasks.some((t) => t.last?.running)}<span class="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-primary"></span>{/if}
        </button>
      {/if}
      {#if ui.claude.agent !== 'cursor-agent'}
        <button class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" aria-label="分叉当前会话" onclick={() => (claudeOpen = true)}>
          <GitFork class="size-3.5 text-primary" />分叉
        </button>
      {/if}
      <button class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] active:bg-accent" onclick={() => (claudeOpen = true)}>
        <Sparkles class="size-3.5 text-primary" />会话
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
/>
<CreatePane bind:open={createOpen} target={createTarget} ondone={() => (pickOpen = false)} />
<RenameSheet bind:open={renameOpen} pane={actPane} />
<NotifySheet bind:open={notifOpen} bind:on={pushOn} />
<KeyEditor bind:open={keysOpen} />
<Inbox bind:open={inboxOpen} />
<ClaudeSheet bind:open={claudeOpen} />
<CronSheet bind:open={cronOpen} />
<Reader bind:open={readerOpen} onpreview={() => (mode = 'preview')} />
<Toaster theme="system" position="top-center" />
