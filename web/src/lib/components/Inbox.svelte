<script lang="ts">
  // 审批收件箱：所有在等你操作的 pane 汇总在这里，不用切过去就能直接回答
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import { label, sendRaw } from '$lib/api'
  import { ui, select, pollStates, type Choice } from '$lib/session.svelte'
  import { cn } from '$lib/utils'

  import { cursorSummary, pollCursorSummary, cursorCmd } from '$lib/cursor/cursor.svelte'
  import CursorIcon from '$lib/cursor/CursorIcon.svelte'

  let { open = $bindable(false), oncursor }: { open?: boolean; oncursor?: (id: string) => void } = $props()
  const waiting = $derived(Object.entries(ui.states).filter(([, s]) => s.state === 'waiting'))
  const total = $derived(waiting.length + cursorSummary.waiting.length)
  $effect(() => { if (open) pollCursorSummary() })
  async function choose(id: string, label: string) {
    try { await cursorCmd('choose', { id, label }); toast(`已在 Cursor 里点了「${label}」`); setTimeout(pollCursorSummary, 1500) } catch (e) { toast.error(`没点成：${(e as Error).message}`) }
  }
  const name = (id: string) => { const p = ui.panes.find((x) => String(x.pane) === id); return p ? `#${id} ${label(p)}` : `#${id}` }
  $effect(() => { if (open) pollStates() })

  function answer(id: string, c: Choice) {
    for (const s of c.send) sendRaw(id, s, false)
    toast(`已回答 ${name(id)}：${c.label}`)
    // 先从列表里拿掉，等下一轮状态刷新确认
    delete ui.states[id]
    setTimeout(pollStates, 1500)
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[85dvh]">
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>等你操作（{total}）</Drawer.Title></Drawer.Header>
    <div data-vaul-no-drag class="grid gap-2 overflow-y-auto overscroll-contain p-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)]">
      {#if !total}<p class="p-6 text-center text-sm text-muted-foreground">现在没有 pane 或 Cursor 会话在等你</p>{/if}
      {#each cursorSummary.waiting as w (w.id)}
        <div class="rounded-xl border bg-card p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="flex min-w-0 items-center gap-1.5 font-semibold"><CursorIcon class="size-3.5 flex-none" /><span class="truncate">{w.title || 'Cursor 会话'}</span></span>
            <Button variant="ghost" size="sm" onclick={() => { open = false; oncursor?.(w.id) }}>打开</Button>
          </div>
          <p class="mt-1 text-[13px] text-warn">{w.project} · {w.status || '在等你'}</p>
          {#if w.choices.length}
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each w.choices as c (c)}<button class="h-9 rounded-lg border border-primary/40 px-3 text-[13px] active:bg-primary active:text-primary-foreground" onclick={() => choose(w.id, c)}>{c}</button>{/each}
            </div>
          {:else}
            <p class="mt-1 text-xs text-muted-foreground">没认出可点的选项，打开看看</p>
          {/if}
        </div>
      {/each}
      {#each waiting as [id, s] (id)}
        <div class="rounded-xl border bg-card p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="min-w-0 truncate font-semibold">{name(id)}</span>
            <Button variant="ghost" size="sm" onclick={() => { open = false; select(id) }}>打开</Button>
          </div>
          <p class="mt-1 text-[13px] text-warn">{s.prompt}</p>
          {#if s.choices.length}
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each s.choices as c, i (i)}
                <button
                  class={cn('h-9 max-w-full truncate rounded-lg border px-3 text-[13px] active:bg-primary active:text-primary-foreground', c.label === 'Esc' ? 'bg-secondary text-muted-foreground' : 'border-primary/40', c.selected && 'border-primary ring-1 ring-primary')}
                  onclick={() => answer(id, c)}
                >{c.label}</button>
              {/each}
            </div>
          {:else}
            <p class="mt-1 text-xs text-muted-foreground">没认出可点的选项，打开看看</p>
          {/if}
        </div>
      {/each}
    </div>
  </Drawer.Content>
</Drawer.Root>
