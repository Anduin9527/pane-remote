<script lang="ts">
  // 画面停下来 300ms 后看底部有没有选择器 / 确认 / y/n，有就把选项变成按钮
  import { onMount } from 'svelte'
  import { sendRaw } from '$lib/api'
  import { detectPrompt, type Prompt } from '$lib/prompts'
  import * as session from '$lib/session.svelte'
  import { ui, onFrame } from '$lib/session.svelte'
  import { cn } from '$lib/utils'

  let prompt = $state<Prompt | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  onMount(() => {
    const off = onFrame(() => {
      clearTimeout(timer)
      timer = setTimeout(() => { prompt = detectPrompt(session.lines) }, 300)
    })
    return () => { off(); clearTimeout(timer) }
  })
  $effect(() => { ui.current; prompt = null })

  function press(send: string[]) {
    for (const s of send) sendRaw(ui.current, s, false) // 每段单独一个请求，回车不会被当成粘贴
    prompt = null // 等画面变化后重新识别
  }
</script>

{#if prompt}
  <div class="border-b border-primary/30 bg-primary/10 px-2.5 pt-2 pb-1.5">
    {#if prompt.question}<p class="mb-1.5 truncate text-xs text-muted-foreground">{prompt.question}</p>{/if}
    <div class="no-scrollbar flex gap-1.5 overflow-x-auto">
      {#each prompt.buttons as b, i (i)}
        <button
          type="button"
          class={cn(
            'h-9 max-w-[70vw] flex-none truncate rounded-lg border px-3 text-[13px] font-medium',
            b.kind === 'esc' ? 'bg-secondary text-muted-foreground' : 'border-primary/40 bg-card text-foreground active:bg-primary active:text-primary-foreground',
            b.selected && 'border-primary ring-1 ring-primary',
            b.kind === 'yes' && 'min-w-14 border-ok/50 text-ok',
            b.kind === 'no' && 'min-w-14 border-destructive/50 text-destructive',
          )}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => press(b.send)}
        >{b.label}</button>
      {/each}
    </div>
  </div>
{/if}
