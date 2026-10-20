<script lang="ts">
  // 注入了 pane-remote 插件的 agent 用 ask_phone 问你的问题：不管在哪个页面都浮在顶栏下面，点选项或写一句话回答。
  // 「稍后」只是这台手机上先收起，问题还挂在 Inbox 里，agent 那边继续等到超时。
  import { toast } from 'svelte-sonner'
  import X from '@lucide/svelte/icons/x'
  import Bot from '@lucide/svelte/icons/bot'
  import { answerAsk, label } from '$lib/api'
  import { ui, select, pollStates, type AgentAsk } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'

  let hidden = $state(new Set<string>())
  let busy = $state(false)
  let text = $state('')
  const all = $derived(Object.entries(ui.states).flatMap(([pane, s]) => (s.asks || []).map((a) => ({ pane, ...a }))).sort((a, b) => a.expires - b.expires))
  const cur = $derived(all.find((a) => !hidden.has(a.id)) as (AgentAsk & { pane: string }) | undefined)
  $effect(() => { cur?.id; text = '' })
  const name = (id: string) => { const p = ui.panes.find((x) => String(x.pane) === id); return p ? `#${id} ${label(p)}` : `#${id}` }

  async function send(answer: string, free = '') {
    if (!cur || busy) return
    const a = cur
    busy = true
    try {
      await answerAsk(a.id, answer, free)
      hidden = new Set([...hidden, a.id])
      toast(t('已回答 {name}：{choice}', { name: name(a.pane), choice: answer || free.slice(0, 30) }))
      setTimeout(pollStates, 800)
    } catch (e) {
      toast.error(t('没答上：{msg}', { msg: tr((e as Error).message) }))
      pollStates()
    } finally {
      busy = false
    }
  }
</script>

{#if cur}
  <div class="fixed inset-x-2 top-[calc(env(safe-area-inset-top)+52px)] z-50 mx-auto max-w-lg rounded-xl border border-primary/40 bg-card p-3 shadow-lg">
    <div class="flex items-center gap-2">
      <Bot class="size-4 flex-none text-primary" />
      <button class="min-w-0 flex-1 truncate text-left text-xs font-semibold" onclick={() => select(cur.pane)}>
        {name(cur.pane)} · {cur.confirm ? t('要你确认') : t('问你')}{all.length > 1 ? ` (${all.length})` : ''}
      </button>
      <button class="grid size-7 place-items-center rounded-md text-muted-foreground active:bg-accent" aria-label={t('稍后')} onclick={() => (hidden = new Set([...hidden, cur.id]))}><X class="size-4" /></button>
    </div>
    <p class="mt-1.5 max-h-40 overflow-y-auto text-[14px] whitespace-pre-wrap">{cur.question}</p>
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#each cur.options as o (o)}
        <button
          disabled={busy}
          class={cn('h-9 max-w-full truncate rounded-lg border border-primary/40 px-3 text-[13px] active:bg-primary active:text-primary-foreground',
            cur.confirm && o === '允许' && 'border-ok/50 text-ok', cur.confirm && o === '拒绝' && 'border-destructive/50 text-destructive')}
          onclick={() => send(o)}
        >{tr(o)}</button>
      {/each}
    </div>
    {#if !cur.confirm}
      <form class="mt-2 flex gap-1.5" onsubmit={(e) => { e.preventDefault(); if (text.trim()) send('', text.trim()) }}>
        <input bind:value={text} placeholder={t('或者直接写回答…')} class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
        <button disabled={busy || !text.trim()} class="h-9 rounded-lg bg-primary px-3 text-[13px] text-primary-foreground disabled:opacity-40">{t('发送')}</button>
      </form>
    {/if}
  </div>
{/if}
