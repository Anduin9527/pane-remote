<script lang="ts">
  // 定时任务面板：Claude 会话里在跑的定时任务（排期、下次、上次结果），一键让会话立即执行 / 重启 / 停止
  import * as Drawer from '$lib/components/ui/drawer'
  import { toast } from 'svelte-sonner'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import { ui } from '$lib/session.svelte'
  import { crons, refreshCrons, cronName, cronNote, cronBody, nextRun, humanCron, clock, relative, cronPrompts, sendPrompt, type CronTask } from './crons.svelte'
  import { cn } from '$lib/utils'
  import { t as tt } from '$lib/i18n'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let now = $state(Date.now())
  let expanded = $state<Record<string, boolean>>({})
  let showPrompt = $state<Record<string, boolean>>({})
  let confirming = $state('')
  let sent = $state<Record<string, keyof typeof cronPrompts>>({}) // 任务 → 刚发过的动作，等会话处理完、列表刷新
  let refreshing = $state(false)

  const data = $derived(crons.pane === ui.current ? crons.data : null)
  const tasks = $derived(data?.tasks ?? [])
  const stopped = $derived(data?.stopped ?? [])

  $effect(() => {
    if (!open) return
    refresh(true)
    const t = setInterval(() => { now = Date.now(); refreshCrons() }, 15000)
    const c = setInterval(() => (now = Date.now()), 30000)
    return () => { clearInterval(t); clearInterval(c) }
  })

  async function refresh(fresh = false) {
    refreshing = true
    await refreshCrons(fresh)
    now = Date.now()
    refreshing = false
  }

  const SENT = { run: tt('已发立即执行'), stop: tt('已发停止'), restart: tt('已发重启'), restore: tt('已发恢复') } as const
  const TOASTS = { run: '已让会话立即执行「{name}」', stop: '已让会话停止「{name}」', restart: '已让会话重启「{name}」', restore: '已让会话恢复「{name}」' } as const
  function act(kind: keyof typeof cronPrompts, t: CronTask) {
    if (kind === 'stop' && confirming !== t.id) {
      confirming = t.id
      setTimeout(() => { if (confirming === t.id) confirming = '' }, 3000)
      return
    }
    confirming = ''
    sendPrompt(cronPrompts[kind](t))
    sent[t.id] = kind
    toast(tt(TOASTS[kind], { name: cronName(t.prompt) }), { description: data?.busy ? tt('会话正忙，会排在当前这轮之后处理') : undefined })
    // 会话处理需要点时间：过一会儿重新扫两次
    setTimeout(() => refresh(true), 12000)
    setTimeout(() => { refresh(true); delete sent[t.id] }, 40000)
  }

  function next(t: CronTask) {
    const d = nextRun(t.cron, new Date(now))
    return d ? `${clock(d.getTime() / 1000)} · ${relative(d.getTime() - now)}` : ''
  }
  function expiry(t: CronTask) {
    if (!t.expiresAt) return null
    const left = t.expiresAt * 1000 - now
    if (left > 2 * 86400000) return null // 离过期还早就不占一行
    return { text: tt('{d}后自动过期', { d: relative(left, true) }), soon: left < 86400000 }
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[90dvh]">
    <Drawer.Header class="flex-row items-center justify-between border-b py-3 text-left">
      <div class="min-w-0">
        <Drawer.Title>{tt('定时任务（{n}）', { n: tasks.length })}</Drawer.Title>
        <Drawer.Description class="text-xs">{tt('只活在这个 Claude 会话里；按钮会往会话里发一条提示词，让它自己处理')}</Drawer.Description>
      </div>
      <button class="grid size-9 flex-none place-items-center rounded-lg text-muted-foreground active:bg-accent" aria-label={tt('刷新')} onclick={() => refresh(true)}>
        <RotateCw class={cn('size-4', refreshing && 'animate-spin')} />
      </button>
    </Drawer.Header>
    <div data-vaul-no-drag class="grid gap-2.5 overflow-y-auto overscroll-contain p-2.5 pb-[calc(env(safe-area-inset-bottom)+12px)]">
      {#if !data}
        <p class="p-6 text-center text-sm text-muted-foreground">{tt('读取中…')}</p>
      {:else if !tasks.length}
        <p class="p-6 text-center text-sm text-muted-foreground">{tt('这个会话现在没有定时任务')}</p>
      {/if}

      {#each tasks as t (t.id)}
        {@const exp = expiry(t)}
        {@const running = t.last?.running}
        <div class={cn('rounded-xl border bg-card p-3', running && 'border-primary/50')}>
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="font-semibold">{cronName(t.prompt)}</div>
              {#if cronNote(t.prompt)}<div class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{cronNote(t.prompt)}</div>{/if}
            </div>
            {#if running}
              <span class="flex flex-none items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"><span class="size-1.5 animate-pulse rounded-full bg-primary"></span>{tt('执行中')}</span>
            {:else if sent[t.id]}
              <span class="flex-none rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{SENT[sent[t.id]]}</span>
            {/if}
          </div>

          <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            <dt class="text-muted-foreground">{tt('排期')}</dt>
            <dd class="flex min-w-0 items-baseline gap-2">{humanCron(t.cron)}<span class="truncate font-mono text-[11px] text-muted-foreground">{t.cron}</span></dd>
            {#if t.recurring || !t.last}
              <dt class="text-muted-foreground">{tt('下次')}</dt>
              <dd>{next(t) || '—'}</dd>
            {/if}
            <dt class="text-muted-foreground">{tt('上次')}</dt>
            <dd>{t.last ? `${clock(t.last.ts)}${t.last.manual ? tt('（手动）') : ''} · ${tt('共跑过 {n} 次', { n: t.last.count })}` : tt('还没跑过')}</dd>
            {#if exp}
              <dt class="text-muted-foreground">{tt('过期')}</dt>
              <dd class={cn(exp.soon && 'text-warn')}>{exp.text}{exp.soon ? tt('，要继续就点「重启」') : ''}</dd>
            {/if}
          </dl>

          {#if t.last?.result}
            <button class="mt-2 block w-full rounded-lg bg-secondary/70 px-2.5 py-2 text-left text-[13px] leading-relaxed" onclick={() => (expanded[t.id] = !expanded[t.id])}>
              <span class={cn('whitespace-pre-wrap break-words', !expanded[t.id] && 'line-clamp-3')}>{t.last.result}</span>
            </button>
          {:else if running}
            <p class="mt-2 text-xs text-muted-foreground">{tt('这一轮还没出结果')}</p>
          {/if}

          <button class="mt-1.5 text-xs text-primary" onclick={() => (showPrompt[t.id] = !showPrompt[t.id])}>{showPrompt[t.id] ? tt('收起提示词') : tt('查看提示词')}</button>
          {#if showPrompt[t.id]}
            <pre class="mt-1 max-h-60 overflow-y-auto rounded-lg border p-2 font-mono text-[11.5px] leading-snug break-words whitespace-pre-wrap">{cronBody(t.prompt)}</pre>
          {/if}

          <div class="mt-2.5 grid grid-cols-3 gap-1.5">
            <button class="h-9 rounded-lg border border-primary/40 text-[13px] font-medium text-primary active:bg-primary active:text-primary-foreground" onclick={() => act('run', t)}>{tt('立即执行')}</button>
            <button class="h-9 rounded-lg border bg-secondary text-[13px] active:bg-accent" onclick={() => act('restart', t)}>{tt('重启')}</button>
            <button
              class={cn('h-9 rounded-lg border text-[13px]', confirming === t.id ? 'border-destructive bg-destructive text-white' : 'bg-secondary text-destructive active:bg-accent')}
              onclick={() => act('stop', t)}
            >{confirming === t.id ? tt('再点一次停止') : tt('停止')}</button>
          </div>
        </div>
      {/each}

      {#if stopped.length}
        <div class="px-1 pt-2 text-xs font-medium text-muted-foreground">{tt('最近停掉的（3 天内）')}</div>
        {#each stopped as t (t.id)}
          <div class="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-medium">{cronName(t.prompt)}</div>
              <div class="truncate text-[11px] text-muted-foreground">
                {humanCron(t.cron)} · {tt(t.expired ? '过期于 {t}' : t.fired ? '已跑完于 {t}' : '停止于 {t}', { t: clock(t.stoppedAt || 0) })}{t.last ? ` · ${tt('跑过 {n} 次', { n: t.last.count })}` : ''}
              </div>
            </div>
            {#if sent[t.id] === 'restore'}
              <span class="flex-none text-[11px] text-muted-foreground">{SENT.restore}</span>
            {:else}
              <button class="h-8 flex-none rounded-lg border bg-secondary px-3 text-[13px] active:bg-accent" onclick={() => act('restore', t)}>{tt('恢复')}</button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
