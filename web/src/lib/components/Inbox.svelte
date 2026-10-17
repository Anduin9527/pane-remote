<script lang="ts">
  // 审批收件箱：所有在等你操作的 pane 汇总在这里，不用切过去就能直接回答
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import { label, sendRaw } from '$lib/api'
  import { ui, select, pollStates, type Choice } from '$lib/session.svelte'
  import { cn } from '$lib/utils'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  const waiting = $derived(Object.entries(ui.states).filter(([, s]) => s.state === 'waiting'))
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
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>等你操作（{waiting.length}）</Drawer.Title></Drawer.Header>
    <div class="grid gap-2 overflow-y-auto overscroll-contain p-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)]">
      {#if !waiting.length}<p class="p-6 text-center text-sm text-muted-foreground">现在没有 pane 在等你</p>{/if}
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
