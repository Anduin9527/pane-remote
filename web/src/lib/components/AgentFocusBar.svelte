<script lang="ts">
  // 焦点跑到后台 agent 列表上 / 正在看某个 subagent 时的提示条，一键回到主会话输入框
  import { onMount } from 'svelte'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { toast } from 'svelte-sonner'
  import { ui, onFrame } from '$lib/session.svelte'
  import { detectAgentFocus, backToMain, type AgentFocus } from '$lib/agentFocus.svelte'

  let focus = $state<AgentFocus>({ kind: 'ok' })
  let busy = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    const read = () => { focus = ui.agent === 'claude' ? detectAgentFocus() : { kind: 'ok' } }
    read()
    const off = onFrame(() => { clearTimeout(timer); timer = setTimeout(read, 250) })
    return () => { off(); clearTimeout(timer) }
  })
  $effect(() => { ui.current; ui.agent; focus = ui.agent === 'claude' ? detectAgentFocus() : { kind: 'ok' } })

  const text = $derived(
    focus.kind === 'viewing' ? `正在看后台 agent「${focus.viewing}」，现在发的消息会发给它，不是主会话`
    : focus.kind === 'list' && focus.selected !== 'main' ? `焦点在后台 agent 列表上，选中了「${focus.selected}」：这时回车会打开它、按 x 会停掉它`
    : focus.kind === 'list' ? '焦点在后台 agent 列表上，打字和发送进不了输入框'
    : '',
  )
  async function back() {
    busy = true
    const ok = await backToMain()
    busy = false
    if (!ok) toast.error('没能自动回到主会话，打开终端视图看一眼')
  }
</script>

{#if text}
  <div class="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs">
    <TriangleAlert class="size-3.5 flex-none text-warn" />
    <span class="min-w-0 flex-1 leading-snug">{text}</span>
    <button class="h-7 flex-none rounded-md border border-warn/50 bg-card px-2 font-medium active:bg-accent" disabled={busy} onclick={back}>
      {busy ? '处理中…' : focus.kind === 'list' && !focus.viewing ? '回到输入框' : '回到主会话'}
    </button>
  </div>
{/if}
