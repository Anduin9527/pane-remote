<script lang="ts">
  // pane 列表：按窗口 / 标签页分组；点行打开，点 ⋯ 管理
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Plus from '@lucide/svelte/icons/plus'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { label, type Pane } from '$lib/api'
  import { ui, loadPanes, select, setStatus } from '$lib/session.svelte'
  import { cn } from '$lib/utils'

  let { open = $bindable(false), onactions, oncreate, onreconnect }: {
    open?: boolean
    onactions: (p: Pane) => void
    onreconnect: () => Promise<void>
    oncreate: (t: { window?: number; dir?: string }) => void
  } = $props()

  let loading = $state(false)
  async function refresh() {
    loading = true
    try { await loadPanes() } catch (e) { setStatus('err', (e as Error).message) } finally { loading = false }
  }
  $effect(() => { if (open) refresh() })

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
  const cur = () => ui.panes.find((p) => String(p.pane) === ui.current)
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[85dvh]">
    <Drawer.Header class="flex-row items-center justify-between border-b py-3">
      <Drawer.Title>选择 pane</Drawer.Title>
      <div class="flex items-center gap-1.5">
        <!-- 手动重连当前 pane（自动重连之外的兜底），顺带刷新列表 -->
        <Button variant="outline" size="sm" class="rounded-full" disabled={!ui.current || loading} onclick={async () => { loading = true; try { await onreconnect(); await refresh() } finally { loading = false } }}>
          <RefreshCw class={cn(loading && 'animate-spin')} /> 重连{ui.current ? ` #${ui.current}` : ''}
        </Button>
        <Button size="sm" class="rounded-full" onclick={() => oncreate({ window: cur()?.window, dir: cur()?.dir })}>
          <Plus /> 新建
        </Button>
      </div>
    </Drawer.Header>
    <div class="overflow-y-auto overscroll-contain px-1.5 pb-[calc(env(safe-area-inset-bottom)+8px)]">
      {#if !ui.panes.length}
        <p class="p-6 text-center text-sm text-muted-foreground">{loading ? '读取中…' : '没有 pane'}</p>
      {/if}
      {#each groups as g (g.window)}
        <div class="flex items-center justify-between gap-2 px-2.5 pt-3.5 pb-1 text-xs text-muted-foreground">
          <span class="truncate">窗口 {g.window}{g.workspace && g.workspace !== 'default' ? ` · ${g.workspace}` : ''}</span>
          <Button variant="ghost" size="xs" class="text-primary" onclick={() => oncreate({ window: g.window, dir: g.dir })}>＋ 标签页</Button>
        </div>
        {#each g.tabs as t (t.tab)}
          <div class="px-3.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">
            标签 {t.tab}{t.title ? ` · ${t.title}` : ''}{t.panes.length > 1 ? ` · ${t.panes.length} 个 pane` : ''}
          </div>
          {#each t.panes as p (p.pane)}
            <div class="flex items-stretch gap-1">
              <button
                class={cn('grid min-w-0 flex-1 gap-0.5 rounded-[10px] py-2.5 pr-2.5 pl-[18px] text-left active:bg-accent', String(p.pane) === ui.current && 'bg-accent')}
                onclick={() => { open = false; select(p.pane) }}
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-semibold">#{p.pane}&nbsp; {label(p)}</span>
                  {#if ui.states[p.pane]?.state === 'waiting'}
                    <span class="flex-none rounded-full bg-warn/20 px-1.5 py-px text-[11px] font-medium text-warn">等你操作</span>
                  {:else if ui.states[p.pane]?.state === 'done'}
                    <span class="flex-none rounded-full bg-ok/15 px-1.5 py-px text-[11px] font-medium text-ok">做完了</span>
                  {:else if ui.states[p.pane]?.state === 'running'}
                    <span class="flex-none rounded-full bg-primary/15 px-1.5 py-px text-[11px] font-medium text-primary">运行中</span>
                  {/if}
                  {#if ui.states[p.pane]?.unread && String(p.pane) !== ui.current}
                    <span class="size-2 flex-none rounded-full bg-primary" title="有新内容"></span>
                  {/if}
                </span>
                <span class="truncate font-mono text-xs text-muted-foreground">{p.cwd}&nbsp; {p.cols}×{p.rows}{p.active ? '  ●' : ''}</span>
                {#if ui.states[p.pane]?.prompt}
                  <span class="truncate text-xs text-warn">{ui.states[p.pane].prompt}</span>
                {/if}
              </button>
              <button class="grid w-11 place-items-center rounded-[10px] text-muted-foreground active:bg-accent" aria-label="#{p.pane} 操作" onclick={() => onactions(p)}>
                <Ellipsis class="size-5" />
              </button>
            </div>
          {/each}
        {/each}
      {/each}
    </div>
  </Drawer.Content>
</Drawer.Root>
