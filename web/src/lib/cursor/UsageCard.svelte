<script lang="ts" module>
  // 模块级缓存：关掉列表再打开，1 分钟内不重新查
  let cache: any = null
</script>

<script lang="ts">
  // Cursor 本计费周期的用量（跟 Cursor 设置里 Usage 同一个接口）。会话列表顶上，打开时拉一次，1 分钟内复用，点一下刷新
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'

  type Usage = {
    plan: string; start: number | null; end: number | null
    used: number | null; limit: number | null; remaining: number | null
    autoPct: number | null; apiPct: number | null; totalPct: number | null
    bonus: boolean; at: number
  }

  let usage = $state<Usage | null>(cache)
  let loading = $state(false)
  let error = $state('')

  async function load(force = false) {
    if (loading) return
    if (!force && cache && Date.now() - cache.at < 60000) { usage = cache; return }
    loading = true
    error = ''
    try {
      // 跟其它 Cursor 命令同一个接口，但不走 cursorCmd：不占用 cur.busy（那会让会话页的按钮转圈）
      const r = await fetch('api/cursor/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'usage' }) })
      const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
      if (!d.ok) throw new Error(d.error ? tr(d.error) : t('失败'))
      usage = cache = d.data
    } catch (e) { error = (e as Error).message }
    finally { loading = false }
  }
  $effect(() => { load() })

  const money = (c: number | null) => (c == null ? '—' : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`)
  const pct = (v: number | null) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`)
  const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : '')
  const daysLeft = $derived(usage?.end ? Math.max(0, Math.ceil((usage.end - Date.now()) / 86400000)) : null)
  const spentPct = $derived(usage?.used != null && usage?.limit ? (usage.used / usage.limit) * 100 : null)
  const bar = (v: number | null) => `${Math.min(100, Math.max(0, v ?? 0))}%`
  const tone = (v: number | null) => ((v ?? 0) >= 90 ? 'bg-destructive' : (v ?? 0) >= 70 ? 'bg-warn' : 'bg-primary')
</script>

<button class="mx-1 mb-1 grid w-[calc(100%-0.5rem)] gap-2 rounded-xl border bg-card px-3 py-2.5 text-left active:bg-accent" onclick={() => load(true)} aria-label={t('刷新 Cursor 用量')}>
  <div class="flex items-center gap-2 text-[13px]">
    <strong>{t('本周期用量')}</strong>
    {#if usage?.plan}<span class="rounded bg-secondary px-1.5 text-[11px] uppercase text-muted-foreground">{usage.plan}</span>{/if}
    <span class="ml-auto text-xs text-muted-foreground">
      {#if usage?.start}{day(usage.start)} – {day(usage.end)}{#if daysLeft != null}&nbsp;· {t('还剩 {n} 天', { n: daysLeft })}{/if}{/if}
    </span>
    <RefreshCw class={cn('size-3.5 text-muted-foreground', loading && 'animate-spin')} />
  </div>
  {#if error && !usage}
    <p class="text-xs text-destructive">{error}</p>
  {:else if usage}
    {#each [[t('Auto / Composer'), usage.autoPct], [t('API（指定模型）'), usage.apiPct]] as [name, v] (name)}
      <div class="grid gap-1">
        <div class="flex text-xs"><span class="text-muted-foreground">{name}</span><span class="ml-auto tabular-nums">{pct(v as number | null)}</span></div>
        <div class="h-1.5 overflow-hidden rounded-full bg-secondary"><div class={cn('h-full rounded-full', tone(v as number | null))} style:width={bar(v as number | null)}></div></div>
      </div>
    {/each}
    <div class="flex text-xs text-muted-foreground">
      <span>{spentPct != null ? t('按金额 {used} / {limit}（{p}）', { used: money(usage.used), limit: money(usage.limit), p: pct(spentPct) }) : t('按金额 {used} / {limit}', { used: money(usage.used), limit: money(usage.limit) })}</span>
      <span class="ml-auto">{t('合计 {p}', { p: pct(usage.totalPct) })}</span>
    </div>
    {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
  {:else}
    <p class="text-xs text-muted-foreground">{t('查询中…')}</p>
  {/if}
</button>
