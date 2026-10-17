<script lang="ts">
  // Cursor 的 Changes 面板：这个会话改过的文件，每个文件原来 → 现在的差异（电脑上算好，按文件折叠）
  import X from '@lucide/svelte/icons/x'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { cn } from '$lib/utils'
  import { cursorCmd } from './cursor.svelte'

  type F = { file: string; rel: string; isNew: boolean; deleted: boolean; adds: number; dels: number; diff: string; same?: boolean; binary?: boolean; truncated?: boolean; omitted?: boolean }
  let { open = $bindable(false), id, title, onfiles }: { open?: boolean; id: string; title: string; onfiles?: (path: string) => void } = $props()
  let data = $state<{ path: string; total: number; shown: number; files: F[] } | null>(null)
  let error = $state('')
  let loading = $state(false)
  let expanded = $state<Record<string, boolean>>({})

  async function load() {
    if (!id) return
    loading = true; error = ''
    try { data = (await cursorCmd('changes', { id })).data } catch (e) { error = (e as Error).message } finally { loading = false }
  }
  $effect(() => { if (open) { data = null; expanded = {}; load() } })
  const lineCls = (l: string) => l.startsWith('+++') || l.startsWith('---') ? 'text-muted-foreground' : l.startsWith('+') ? 'bg-ok/15 text-ok' : l.startsWith('-') ? 'bg-destructive/12 text-destructive' : l.startsWith('@@') ? 'text-primary' : ''
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
    <header class="flex flex-none items-center gap-2 border-b bg-card px-2 py-2">
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="关闭" onclick={() => (open = false)}><X class="size-5" /></button>
      <div class="min-w-0 flex-1">
        <strong class="block truncate">改动</strong>
        <span class="block truncate text-xs text-muted-foreground">{title}</span>
      </div>
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label="刷新" onclick={load}><RotateCw class={cn('size-4', loading && 'animate-spin')} /></button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 pb-[calc(env(safe-area-inset-bottom)+12px)]">
      {#if error}<p class="p-6 text-center text-sm text-destructive">{error}</p>
      {:else if !data}<p class="p-6 text-center text-sm text-muted-foreground">在电脑上对比改动…</p>
      {:else}
        <p class="mb-2 px-1 text-xs text-muted-foreground">
          对比的是这个会话第一次改之前的内容和现在磁盘上的文件。{data.total > data.shown ? `共 ${data.total} 个文件，只列前 ${data.shown} 个。` : ''}
          {#if data.path}<button class="text-primary" onclick={() => { open = false; onfiles?.(data!.path + '/') }}>打开项目目录</button>{/if}
        </p>
        <p class="mb-2 px-1 text-xs text-muted-foreground">Cursor 里出现「保留 / 撤销」之类的按钮时，会显示在对话页底部「Cursor 在等你」那一栏，也会进待办。</p>
        <div class="grid gap-2">
          {#each data.files as f (f.file)}
            <div class="min-w-0 rounded-xl border bg-card">
              <button class="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left" onclick={() => (expanded[f.file] = !expanded[f.file])}>
                <ChevronRight class={cn('size-4 flex-none text-muted-foreground transition-transform', expanded[f.file] && 'rotate-90')} />
                <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{f.rel}</span>
                {#if f.isNew}<span class="flex-none rounded bg-ok/15 px-1.5 text-[10px] text-ok">新建</span>{/if}
                {#if f.deleted}<span class="flex-none rounded bg-destructive/15 px-1.5 text-[10px] text-destructive">已删除</span>{/if}
                {#if f.same}<span class="flex-none text-[11px] text-muted-foreground">现在和原来一样</span>
                {:else if f.binary}<span class="flex-none text-[11px] text-muted-foreground">二进制 / 太大</span>
                {:else}<span class="flex-none font-mono text-[11px]"><span class="text-ok">+{f.adds}</span> <span class="text-destructive">−{f.dels}</span></span>{/if}
              </button>
              {#if expanded[f.file]}
                {#if f.diff}
                  <pre class="overflow-x-auto border-t py-1 font-mono text-[11px] leading-[1.45]">{#each f.diff.split('\n') as l, i (i)}<div class={cn('px-3 whitespace-pre', lineCls(l))}>{l || ' '}</div>{/each}</pre>
                {:else}
                  <p class="border-t px-3 py-2 text-xs text-muted-foreground">{f.omitted ? '差异总量太大，这个文件没带过来' : f.same ? '没有差异' : '看不了差异'}</p>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="p-6 text-center text-sm text-muted-foreground">这个会话没有改过文件</p>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
