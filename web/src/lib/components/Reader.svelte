<script lang="ts">
  // 阅读模式：终端内容转成纯文本，能原生选中复制、搜索；网址 / localhost / 文件路径可以直接在预览里打开
  import X from '@lucide/svelte/icons/x'
  import Copy from '@lucide/svelte/icons/copy'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Globe from '@lucide/svelte/icons/globe'
  import { toast } from 'svelte-sonner'
  import { stripAnsi } from '$lib/prompts'
  import * as session from '$lib/session.svelte'
  import { openInPreview } from '$lib/preview/request.svelte'

  let { open = $bindable(false), onpreview }: { open?: boolean; onpreview: () => void } = $props()
  let text = $state('')
  let query = $state('')
  let hit = $state(0)
  let body = $state<HTMLDivElement>()

  // 打开时拍一张快照（之后画面再变也不动，方便选中）
  $effect(() => {
    if (!open) return
    const ls = session.lines.map((l) => stripAnsi(l).replace(/\s+$/, ''))
    while (ls.length && !ls[ls.length - 1]) ls.pop()
    text = ls.join('\n')
    query = ''
    queueMicrotask(() => body?.scrollTo(0, body.scrollHeight))
  })

  const LINK_RE = /(https?:\/\/[^\s<>"'`│]+[^\s<>"'`│.,;:!?)\]}])|((?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}[^\s"'`│]*)|((?:~|\/Users|\/tmp|\/private)\/[^\s"'`│:]+\.(?:html?|svg|png|jpe?g|gif|webp|pdf|md|txt|json))/g
  const links = $derived([...new Set([...text.matchAll(LINK_RE)].map((m) => m[0]))].slice(-12).reverse())

  type Part = { t: string; mark?: number }
  const parts = $derived.by(() => {
    if (!query) return [{ t: text }] as Part[]
    const out: Part[] = []
    const q = query.toLowerCase(), low = text.toLowerCase()
    let i = 0, n = 0
    for (;;) {
      const j = low.indexOf(q, i)
      if (j < 0 || n > 500) break
      out.push({ t: text.slice(i, j) }, { t: text.slice(j, j + q.length), mark: n++ })
      i = j + q.length
    }
    out.push({ t: text.slice(i) })
    return out
  })
  const total = $derived(parts.filter((p) => p.mark != null).length)
  $effect(() => { query; hit = Math.max(0, total - 1) }) // 默认跳到最后一个（最新的输出）
  $effect(() => {
    if (!total) return
    body?.querySelector(`[data-mark="${hit}"]`)?.scrollIntoView({ block: 'center' })
  })

  async function copy(s: string, what: string) {
    try { await navigator.clipboard.writeText(s); toast(`已复制${what}`) } catch { toast.error('复制失败（需要 HTTPS）') }
  }
  function preview(u: string) {
    open = false
    openInPreview(u)
    onpreview()
  }
  const sel = () => window.getSelection()?.toString() || ''
</script>

{#if open}
  <div class="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
    <div class="flex items-center gap-1.5 border-b bg-card px-2 py-1.5">
      <input
        bind:value={query}
        placeholder="搜索"
        autocapitalize="off"
        spellcheck="false"
        class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 outline-none focus:ring-2 focus:ring-ring"
      />
      {#if query}
        <span class="flex-none text-xs text-muted-foreground tabular-nums">{total ? hit + 1 : 0}/{total}</span>
        <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="上一个" onclick={() => (hit = (hit - 1 + total) % Math.max(1, total))}><ChevronUp class="size-4" /></button>
        <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="下一个" onclick={() => (hit = (hit + 1) % Math.max(1, total))}><ChevronDown class="size-4" /></button>
      {/if}
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="复制" onclick={() => { const s = sel(); copy(s || text, s ? '选中的文字' : '全部内容') }}><Copy class="size-4" /></button>
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="关闭" onclick={() => (open = false)}><X class="size-4" /></button>
    </div>
    {#if links.length}
      <div class="no-scrollbar flex gap-1.5 overflow-x-auto border-b bg-card px-2 py-1.5">
        {#each links as u (u)}
          <span class="flex flex-none items-center overflow-hidden rounded-full border text-xs">
            <button class="flex max-w-[60vw] items-center gap-1 truncate py-1 pr-1.5 pl-2.5 active:bg-accent" onclick={() => preview(u)}><Globe class="size-3 flex-none" /><span class="truncate font-mono">{u}</span></button>
            <button class="border-l px-2 py-1 text-muted-foreground active:bg-accent" aria-label="复制链接" onclick={() => copy(u, '链接')}><Copy class="size-3" /></button>
          </span>
        {/each}
      </div>
    {/if}
    <div bind:this={body} class="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#1a1b26] p-3 text-[#c0caf5] select-text">
      <pre class="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap select-text">{#each parts as p, i (i)}{#if p.mark != null}<mark data-mark={p.mark} class={p.mark === hit ? 'bg-[#e0af68] text-black' : 'bg-[#e0af68]/40 text-inherit'}>{p.t}</mark>{:else}{p.t}{/if}{/each}</pre>
    </div>
  </div>
{/if}
