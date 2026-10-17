<script lang="ts">
  // 电脑上 Claude 输入框的状态：
  // - 里面已经有字（在电脑上打了一半，或按 Tab 采纳了推荐）：显示出来，可以直接提交，或接到手机上接着改
  // - 空着但有推荐（暗淡的提示文字）：显示推荐，可以直接发送，或放进手机输入框改一改
  // 对话模式下 Claude 在跑时，再给一个「中断」（等于按 Esc）
  import { onMount } from 'svelte'
  import Lightbulb from '@lucide/svelte/icons/lightbulb'
  import Laptop from '@lucide/svelte/icons/laptop'
  import { sendRaw } from '$lib/api'
  import { readAgentInput, type ClaudeInput } from '$lib/claudeInput'
  import { composer } from '$lib/composer.svelte'
  import * as session from '$lib/session.svelte'
  import { ui, onFrame, agentName } from '$lib/session.svelte'
  import { t } from '$lib/i18n'

  let { chat = false }: { chat?: boolean } = $props()
  let input = $state<ClaudeInput | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    const read = () => { input = readAgentInput(session.lines, ui.agent || undefined) }
    read()
    const off = onFrame(() => { clearTimeout(timer); timer = setTimeout(read, 300) })
    return () => { off(); clearTimeout(timer) }
  })
  $effect(() => { ui.current; input = readAgentInput(session.lines, ui.agent || undefined) })

  const paneState = $derived(ui.states[ui.current ?? '']?.state)
  const running = $derived(paneState === 'running')
  // 输入框同步 / 推荐：Claude、Codex、cursor-agent（各自的输入框画法见 claudeInput.ts）
  const show = $derived(!composer.text && input && ['claude', 'codex', 'cursor-agent'].includes(ui.agent))

  function take() {
    if (!input) return
    composer.text = input.typed
    composer.eraseFirst = [...input.typed].length
    composer.focusTick++
  }
  function submitTyped() { sendRaw(ui.current, '\r', false) }
  function sendSuggestion() {
    if (!input?.suggestion) return
    sendRaw(ui.current, input.suggestion, false)
    sendRaw(ui.current, '\r', false)
  }
  function editSuggestion() {
    if (!input?.suggestion) return
    composer.text = input.suggestion
    composer.eraseFirst = 0
    composer.focusTick++
  }
  const btn = 'h-7 flex-none rounded-md border px-2 text-xs active:bg-accent'
</script>

{#if chat && running}
  <div class="flex items-center gap-2 px-2.5 pt-1.5">
    <span class="flex-1 animate-pulse text-xs text-primary">{t('{agent} 正在工作…', { agent: agentName() })}</span>
    <button class={btn} onclick={() => sendRaw(ui.current, '\x1b', false)}>{t('中断')}</button>
  </div>
{/if}
{#if show && input?.typed}
  <div class="mx-2.5 mt-1.5 flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5">
    <Laptop class="size-3.5 flex-none text-muted-foreground" />
    <span class="min-w-0 flex-1 truncate text-[13px]"><span class="text-muted-foreground">{t('电脑输入框：')}</span>{input.typed.replace(/\n/g, ' ⏎ ')}</span>
    <button class={btn} onclick={take}>{t('接过来改')}</button>
    <button class="{btn} border-primary text-primary" onclick={submitTyped}>{t('提交')}</button>
  </div>
{:else if show && input?.suggestion && !running}
  <div class="mx-2.5 mt-1.5 flex items-center gap-2 rounded-lg border border-dashed bg-card px-2 py-1.5">
    <Lightbulb class="size-3.5 flex-none text-warn" />
    <button class="min-w-0 flex-1 truncate text-left text-[13px] text-muted-foreground" onclick={editSuggestion}>{input.suggestion}</button>
    <button class={btn} onclick={editSuggestion}>{t('改一改')}</button>
    <button class="{btn} border-primary text-primary" onclick={sendSuggestion}>{t('发送')}</button>
  </div>
{/if}
