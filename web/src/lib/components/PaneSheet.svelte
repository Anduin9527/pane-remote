<script lang="ts">
  // 会话列表：WezTerm 的 pane（按窗口 / 标签页分组）和 Cursor 的会话（按项目分组）合在一起；点行打开，pane 点 ⋯ 管理。
  // 状态标记统一：等你操作 / 做完了 / 运行中 / 蓝点 = 有新内容
  import { onDestroy, untrack } from 'svelte'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Plus from '@lucide/svelte/icons/plus'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { label, type Pane } from '$lib/api'
  import { ui, loadPanes, pollStates, select, setStatus } from '$lib/session.svelte'
  import { cur, holdCursor, startDraft } from '$lib/cursor/cursor.svelte'
  import { cursorSessions, type SessionStatus } from '$lib/sessions.svelte'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'
  import { route, go, cursorView } from '$lib/router.svelte'
  import { appConfig } from '$lib/appConfig.svelte'
  import { cn } from '$lib/utils'
  import { t as tt, tr } from '$lib/i18n'

  let { open = $bindable(false), onactions, oncreate, onreconnect }: {
    open?: boolean
    onactions: (p: Pane) => void
    onreconnect: () => Promise<void>
    oncreate: (t: { window?: number; dir?: string }) => void
  } = $props()

  let loading = $state(false)
  async function refresh() {
    loading = true
    pollStates()
    try { await loadPanes() } catch (e) { setStatus('err', (e as Error).message) } finally { loading = false }
  }
  // 打开时刷新 pane 列表，并接上 Cursor 的推送连接拿项目 / 会话列表（只要列表，不改电脑那边盯着的会话；没开 Cursor 模块就不接）
  let release: (() => void) | null = null
  $effect(() => {
    if (!open) return
    untrack(() => { refresh(); if (appConfig.modules.cursor) release = holdCursor('list') })
    return () => { release?.(); release = null }
  })
  onDestroy(() => release?.())

  const groups = $derived.by(() => {
    const out: { window: number; workspace: string; dir: string; tabs: { tab: number; title: string; panes: Pane[] }[] }[] = []
    for (const p of ui.panes) {
      let w = out.find((g) => g.window === p.window)
      if (!w) out.push((w = { window: p.window, workspace: p.workspace, dir: p.dir, tabs: [] }))
      let t = w.tabs.find((x) => x.tab === p.tab)
      if (!t) w.tabs.push((t = { tab: p.tab, title: p.tabTitle, panes: [] }))
      t.panes.push(p)
    }
    return out
  })
  const curPane = () => ui.panes.find((p) => String(p.pane) === ui.current)
  const onPane = $derived(route.view.kind === 'pane')
  const onCursor = $derived(route.view.kind === 'cursor')

  function openCursor(id: string) {
    go(cursorView(id))
  }
  function newCursor(project: string) {
    startDraft(project)
    go(cursorView(''))
  }
</script>

{#snippet badge(state: SessionStatus | undefined, unread: boolean, current: boolean)}
  {#if state === 'waiting'}
    <span class="flex-none rounded-full bg-warn/20 px-1.5 py-px text-[11px] font-medium text-warn">{tt('等你操作')}</span>
  {:else if state === 'done'}
    <span class="flex-none rounded-full bg-ok/15 px-1.5 py-px text-[11px] font-medium text-ok">{tt('做完了')}</span>
  {:else if state === 'running'}
    <span class="flex-none rounded-full bg-primary/15 px-1.5 py-px text-[11px] font-medium text-primary">{tt('运行中')}</span>
  {:else if state === 'error'}
    <span class="flex-none rounded-full bg-destructive/15 px-1.5 py-px text-[11px] font-medium text-destructive">{tt('出错')}</span>
  {/if}
  {#if unread && !current}
    <span class="size-2 flex-none rounded-full bg-primary" title={tt('有新内容')}></span>
  {/if}
{/snippet}

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[85dvh]">
    <Drawer.Header class="flex-row items-center justify-between border-b py-3">
      <Drawer.Title>{tt('会话列表')}</Drawer.Title>
      <div class="flex items-center gap-1.5">
        <!-- 手动重连当前 pane（自动重连之外的兜底），顺带刷新列表 -->
        <Button variant="outline" size="sm" class="rounded-full" disabled={!ui.current || loading} onclick={async () => { loading = true; try { await onreconnect(); await refresh() } finally { loading = false } }}>
          <RefreshCw class={cn(loading && 'animate-spin')} /> {tt('重连')}{ui.current ? ` #${ui.current}` : ''}
        </Button>
        <Button size="sm" class="rounded-full" onclick={() => oncreate({ window: curPane()?.window, dir: curPane()?.dir })}>
          <Plus /> {tt('新建')}
        </Button>
      </div>
    </Drawer.Header>
    <div data-vaul-no-drag class="overflow-y-auto overscroll-contain px-1.5 pb-[calc(env(safe-area-inset-bottom)+8px)]" data-testid="session-list">
      {#if !ui.panes.length}
        <p class="p-6 text-center text-sm text-muted-foreground">{loading ? tt('读取中…') : tt('没有 pane')}</p>
      {/if}
      {#each groups as g (g.window)}
        <div class="flex items-center justify-between gap-2 px-2.5 pt-3.5 pb-1 text-xs text-muted-foreground">
          <span class="truncate">{tt('窗口 {w}', { w: g.window })}{g.workspace && g.workspace !== 'default' ? ` · ${g.workspace}` : ''}</span>
          <Button variant="ghost" size="xs" class="text-primary" onclick={() => oncreate({ window: g.window, dir: g.dir })}>{tt('＋ 标签页')}</Button>
        </div>
        {#each g.tabs as t (t.tab)}
          <div class="px-3.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">
            {tt('标签 {tab}', { tab: t.tab })}{t.title ? ` · ${t.title}` : ''}{t.panes.length > 1 ? ` · ${tt('{n} 个 pane', { n: t.panes.length })}` : ''}
          </div>
          {#each t.panes as p (p.pane)}
            {@const current = onPane && String(p.pane) === ui.current}
            <div class="flex items-stretch gap-1">
              <button
                class={cn('grid min-w-0 flex-1 gap-0.5 rounded-[10px] py-2.5 pr-2.5 pl-[18px] text-left active:bg-accent', current && 'bg-accent')}
                onclick={() => { open = false; select(p.pane) }}
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-semibold">#{p.pane}&nbsp; {label(p)}</span>
                  {@render badge(ui.states[p.pane]?.state, !!ui.states[p.pane]?.unread, current)}
                </span>
                <span class="truncate font-mono text-xs text-muted-foreground">{p.cwd}&nbsp; {p.cols}×{p.rows}{p.active ? '  ●' : ''}</span>
                {#if ui.states[p.pane]?.prompt}
                  <span class="truncate text-xs text-warn">{ui.states[p.pane].prompt}</span>
                {/if}
              </button>
              <button class="grid w-11 place-items-center rounded-[10px] text-muted-foreground active:bg-accent" aria-label={tt('#{pane} 操作', { pane: p.pane })} onclick={() => onactions(p)}>
                <Ellipsis class="size-5" />
              </button>
            </div>
          {/each}
        {/each}
      {/each}

      <!-- Cursor：电脑上 Cursor IDE 的 Agent 会话，一个项目一组（开了 Cursor 模块才有） -->
      {#if appConfig.modules.cursor}
      <div class="mt-2 flex items-center justify-between gap-2 border-t px-2.5 pt-3.5 pb-1 text-xs text-muted-foreground" data-testid="cursor-group">
        <span class="flex min-w-0 items-center gap-1.5"><CursorIcon class="size-3.5 flex-none text-foreground" /><span class="truncate">Cursor</span>
          {#if cur.conn !== 'ready'}<span class="truncate">· {tr(cur.msg) || (cur.conn === 'not-running' ? tt('电脑上的 Cursor 没有打开') : tt('还没接入 Cursor'))}</span>{/if}
        </span>
        <Button variant="ghost" size="xs" class="text-primary" onclick={() => newCursor('')}>{tt('＋ 新对话')}</Button>
      </div>
      {#if cur.conn !== 'ready'}
        <button class={cn('flex w-full min-w-0 items-center gap-2 rounded-[10px] py-2.5 pr-2.5 pl-[18px] text-left text-sm active:bg-accent', onCursor && 'bg-accent')} onclick={() => go(cursorView(cur.id))}>
          <span class="min-w-0 flex-1 truncate">{tt('打开 Cursor 页')}</span>
        </button>
      {:else}
        {#if open}
          {#await import('$lib/cursor/UsageCard.svelte') then M}<M.default />{/await}
        {/if}
        {#each cur.projects as p (p.id)}
          {#if p.sessions.length || p.uri}
            <div class="flex items-center justify-between gap-2 px-3.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">
              <span class="truncate">{tr(p.label)}</span>
              {#if p.uri}<button class="flex flex-none items-center gap-0.5 rounded px-1.5 py-0.5 text-primary active:bg-accent" onclick={() => newCursor(p.id)}><Plus class="size-3" />{tt('新 Agent')}</button>{/if}
            </div>
            {#each p.sessions as s (s.id)}
              {@const current = onCursor && s.id === cur.id}
              <button class={cn('grid w-full min-w-0 gap-0.5 rounded-[10px] py-2.5 pr-2.5 pl-[18px] text-left active:bg-accent', current && 'bg-accent')} onclick={() => openCursor(s.id)}>
                <span class="flex min-w-0 items-center gap-1.5">
                  <CursorIcon class="size-3.5 flex-none text-muted-foreground" />
                  <span class={cn('truncate', s.unread ? 'font-semibold' : 'font-medium')}>{s.title || tt('无标题')}</span>
                  {@render badge(cursorSessions.status(s.id), !!s.unread, current)}
                  {#if s.active}<span class="flex-none rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">{tt('电脑上开着')}</span>{/if}
                  <span class="ml-auto flex-none text-xs text-muted-foreground">{s.age}</span>
                </span>
              </button>
            {/each}
          {/if}
        {:else}
          <p class="p-4 text-center text-sm text-muted-foreground">{tt('没有会话')}</p>
        {/each}
      {/if}
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
