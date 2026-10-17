<script lang="ts">
  // 对话视图：直接读 Claude 的会话记录，按手机宽度排版（和 pane 有多宽无关）。
  // 回复按 Markdown 渲染，工具调用折叠成一行（点开看结果），链接点了在预览里打开。每 2 秒刷新一次。
  import { onMount, tick } from 'svelte'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import Wrench from '@lucide/svelte/icons/wrench'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import { ui, agentName } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { t as tt, tr, isEn } from '$lib/i18n'

  let { onpreview }: { onpreview?: (url: string) => void } = $props()
  type Part = { type: 'text'; text: string } | { type: 'tool'; name: string; summary: string; result: string | null; error: boolean }
  type Msg = { id: string; role: 'user' | 'assistant'; ts: string; parts: Part[] }
  // 每个 pane 的对话缓存（模块级，组件重建也在）：切回来立刻显示，后台再刷新
  const cache = ((globalThis as any).__chatCache ??= new Map<string, Msg[]>()) as Map<string, Msg[]>
  let msgs = $state<Msg[]>([])
  let loaded = $state(false)
  let error = $state('')
  let box = $state<HTMLDivElement>()
  let atBottom = $state(true)
  let sig = ''

  type ToolPart = Extract<Part, { type: 'tool' }>
  type Block = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolPart } | { kind: 'tools'; tools: ToolPart[] }
  // 连续 3 个以上的工具调用合并成一行「N 次工具调用」，不让它们把文字回复挤下去
  function blocks(parts: Part[]): Block[] {
    const out: Block[] = []
    let run: ToolPart[] = []
    const flush = () => {
      if (run.length >= 3) out.push({ kind: 'tools', tools: run })
      else for (const t of run) out.push({ kind: 'tool', tool: t })
      run = []
    }
    for (const p of parts) {
      if (p.type === 'tool') run.push(p)
      else { flush(); out.push({ kind: 'text', text: p.text }) }
    }
    flush()
    return out
  }
  const toolStats = (ts: ToolPart[]) => {
    const c: Record<string, number> = {}
    for (const t of ts) c[t.name] = (c[t.name] || 0) + 1
    return Object.entries(c).map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(tt('、'))
  }
  const md = (t: string) => DOMPurify.sanitize(marked.parse(t, { gfm: true, breaks: true, async: false }) as string)
  const time = (ts: string) => { try { return new Date(ts).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

  async function load() {
    const pane = ui.current
    if (!pane || document.visibilityState !== 'visible') return
    try {
      const r = await fetch(`api/transcript?pane=${pane}&n=80`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
      const d: Msg[] = await r.json()
      if (pane !== ui.current) return
      error = ''
      const next = JSON.stringify(d.map((m) => [m.id, m.parts.length, m.parts.at(-1)]))
      loaded = true
      if (next === sig) return
      sig = next
      cache.set(pane, d)
      const stick = atBottom
      msgs = d
      await tick()
      if (stick) box?.scrollTo({ top: box.scrollHeight })
    } catch (e) {
      error = (e as Error).message
    }
  }
  onMount(() => {
    load()
    const t = setInterval(load, 2000)
    document.addEventListener('visibilitychange', load)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', load) }
  })
  $effect(() => {
    const pane = ui.current
    const hit = pane ? cache.get(pane) : undefined
    sig = ''
    msgs = hit ?? []
    loaded = !!hit
    atBottom = true
    if (hit) tick().then(() => box?.scrollTo({ top: box.scrollHeight }))
    load()
  })

  // 点链接：网页 / localhost 在预览里打开，不跳出 App
  function onclick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') || ''
    if (/^(https?:|file:)/.test(href)) onpreview?.(href)
  }
  const running = $derived(ui.states[ui.current ?? '']?.state === 'running')
</script>

{#snippet tool(p: ToolPart)}
  <details class={cn('min-w-0 rounded-lg border bg-card text-xs', p.error && 'border-destructive/40')}>
    <summary class="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5">
      <Wrench class={cn('size-3.5 flex-none', p.error ? 'text-destructive' : 'text-muted-foreground')} />
      <span class="flex-none font-medium">{p.name}</span>
      <span class="min-w-0 truncate font-mono text-muted-foreground">{p.summary}</span>
      {#if p.result === null}<span class="ml-auto flex-none animate-pulse text-primary">{tt('运行中')}</span>{/if}
    </summary>
    {#if p.result}<pre class="max-h-72 overflow-auto border-t px-2.5 py-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all text-muted-foreground">{p.result}</pre>{/if}
  </details>
{/snippet}

<div class="relative min-h-0 flex-1">
  <div
    bind:this={box}
    class="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
    onscroll={() => { if (box) atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60 }}
    {onclick}
    role="presentation"
  >
    {#if !loaded}
      <p class="p-6 text-center text-sm text-muted-foreground">{tr(error) || tt('读取对话…')}</p>
    {:else if !msgs.length}
      <p class="p-6 text-center text-sm text-muted-foreground">{tt('还没有对话记录')}</p>
    {/if}
    <!-- 列宽锁在容器宽度内：网格默认会被不能断行的长内容撑宽，出现整页横向滚动 -->
    <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
      {#each msgs as m (m.id)}
        {#if m.role === 'user'}
          <div class="ml-10 max-w-full min-w-0 justify-self-end rounded-2xl rounded-br-md bg-primary/12 px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')}</div>
        {:else}
          <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
            {#each blocks(m.parts) as b, i (i)}
              {#if b.kind === 'text'}
                <div class="md min-w-0 text-[15px] leading-relaxed">{@html md(b.text)}</div>
              {:else if b.kind === 'tool'}
                {@render tool(b.tool)}
              {:else}
                <details class="min-w-0 rounded-lg border bg-card text-xs">
                  <summary class="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5">
                    <Wrench class="size-3.5 flex-none text-muted-foreground" />
                    <span class="flex-none font-medium">{tt('{n} 次工具调用', { n: b.tools.length })}</span>
                    <span class="min-w-0 truncate text-muted-foreground">{toolStats(b.tools)}</span>
                    {#if b.tools.some((t) => t.result === null)}<span class="ml-auto flex-none animate-pulse text-primary">{tt('运行中')}</span>{/if}
                    {#if b.tools.some((t) => t.error)}<span class="ml-auto flex-none text-destructive">{tt('有报错')}</span>{/if}
                  </summary>
                  <div class="grid grid-cols-[minmax(0,1fr)] gap-1 border-t p-1.5">
                    {#each b.tools as t, j (j)}{@render tool(t)}{/each}
                  </div>
                </details>
              {/if}
            {/each}
            <span class="text-[11px] text-muted-foreground">{time(m.ts)}</span>
          </div>
        {/if}
      {/each}
      {#if running}<p class="animate-pulse text-sm text-primary">{tt('{agent} 正在工作…', { agent: agentName() })}</p>{/if}
    </div>
  </div>
  {#if !atBottom}
    <button class="absolute right-3.5 bottom-3 grid size-10 place-items-center rounded-full border bg-card shadow-lg" aria-label={tt('回到底部')} onclick={() => box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })}>
      <ArrowDown class="size-4" />
    </button>
  {/if}
</div>
