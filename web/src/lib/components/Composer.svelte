<script lang="ts">
  // 输入框：整行用手机原生键盘输完再发（中文输入法不会重复上屏）。
  // 收起时回车 = 发送；点右上角展开成大的多行编辑区，展开时回车 = 换行，点「发送」才发。
  // 对话模式：发送 = 提交（文字 + 回车）；长按「发送」= 只填进电脑上的输入框、不提交。
  // 终端模式：保留「附带回车」开关，兼容各种程序。
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import Minimize2 from '@lucide/svelte/icons/minimize-2'
  import { toast } from 'svelte-sonner'
  import { sendRaw } from '$lib/api'
  import { detectAgentFocus, backToMain } from '$lib/agentFocus.svelte'
  import { prefs } from '$lib/prefs.svelte'
  import { ui, agentName } from '$lib/session.svelte'
  import { composer, switchDraft, saveDraft } from '$lib/composer.svelte'
  import { cn } from '$lib/utils'
  import { Button } from '$lib/components/ui/button'

  // draftKey / onsubmit：给别的发送目标复用（比如 Cursor 页面）：草稿按 draftKey 存，发送交给 onsubmit（失败时文字放回输入框）。
  // 不传时就是终端：草稿跟着 pane，发送 = 往 pane 里打字
  let { ctrl = $bindable(false), chat = false, onresize, draftKey, onsubmit, placeholder: ph, disabled = false }: {
    ctrl?: boolean; chat?: boolean; onresize?: () => void
    draftKey?: string | null; onsubmit?: (text: string) => Promise<unknown>; placeholder?: string; disabled?: boolean
  } = $props()
  let el: HTMLTextAreaElement
  let fileEl: HTMLInputElement
  let uploading = $state(0)
  let expanded = $state(false)

  function autosize() {
    if (!el) return
    if (expanded) { el.style.height = ''; onresize?.(); return }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    onresize?.()
  }
  $effect(() => { composer.text; expanded; queueMicrotask(autosize) })
  // 草稿跟着 pane 走
  $effect(() => { switchDraft(draftKey === undefined ? ui.current : draftKey) })
  $effect(() => { composer.text; saveDraft() })
  $effect(() => { if (composer.focusTick) queueMicrotask(() => el?.focus()) })

  // 传文件：存到电脑的 ~/Downloads/pane-remote/，把路径插进输入框（不自动发送，可以接着写说明）
  async function upload() {
    const files = [...(fileEl.files || [])]
    fileEl.value = ''
    for (const f of files) {
      if (f.size > 25 << 20) { toast.error(`${f.name} 超过 25MB`); continue }
      uploading++
      const id = toast.loading(`上传 ${f.name}…`)
      try {
        const r = await fetch(`api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
        const t = composer.text
        composer.text = t && !/\s$/.test(t) ? `${t} ${d.path} ` : `${t}${d.path} `
        toast.success(`已传到电脑：${d.path.split('/').pop()}`, { id })
      } catch (e) {
        toast.error(`上传失败：${(e as Error).message}`, { id })
      } finally {
        uploading--
      }
    }
  }

  function oninput() {
    // Ctrl 模式：输入一个字母就发对应的控制字符
    if (!onsubmit && ctrl && /^[a-zA-Z@[\\\]^_]$/.test(composer.text)) {
      sendRaw(ui.current, String.fromCharCode(composer.text.toUpperCase().charCodeAt(0) & 0x1f))
      composer.text = ''
      ctrl = false
    }
  }

  async function send(submit: boolean) {
    if (onsubmit) {
      const t = composer.text.trim()
      if (!t || disabled) return
      composer.text = ''
      expanded = false
      try { await onsubmit(t) } catch (e) { if (!composer.text) composer.text = t; toast.error(`没发出去：${(e as Error).message}`) }
      return
    }
    const text = composer.text
    if (!text && !submit) return
    const erase = composer.eraseFirst
    const pane = ui.current
    composer.text = ''
    composer.eraseFirst = 0
    expanded = false
    // Claude Code 的焦点跑到了后台 agent 列表上：字进不了输入框、回车会打开选中的 agent、x 会停掉它。先按键回到输入框再发
    if (ui.agent === 'claude' && detectAgentFocus().kind === 'list' && !(await backToMain())) {
      composer.text = text
      toast.error('焦点在后台 agent 列表上，没能自动回到输入框，没有发送')
      return
    }
    // 接过来编辑的电脑草稿：先把电脑输入框里的旧内容删掉
    if (erase > 0) sendRaw(pane, '\x7f'.repeat(erase + 2), false)
    // 多行文字用括号粘贴发送：中间的换行保留成换行，不会被当成回车提前提交（Claude Code、zsh 都认）
    if (text) sendRaw(pane, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text, false)
    if (submit) sendRaw(pane, '\r', false) // 单独一个请求，排在文字后面
  }
  const submitOnSend = () => (chat ? true : prefs.enter)

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !expanded) { e.preventDefault(); send(submitOnSend()) }
  }

  // 对话模式：长按发送 = 只填进电脑输入框，不提交
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let held = false
  function sendDown(e: PointerEvent) {
    e.preventDefault() // 不抢输入框焦点，键盘不收起
    held = false
    if (!chat || onsubmit) return
    holdTimer = setTimeout(() => {
      held = true
      if (!composer.text) return
      navigator.vibrate?.(10)
      send(false)
      toast('已填进电脑上的输入框，没有提交')
    }, 500)
  }
  function sendUp() {
    clearTimeout(holdTimer)
    if (!held) send(submitOnSend())
  }
</script>

<div class={cn('flex gap-1.5 px-2.5 pt-1 pb-2', expanded ? 'flex-col' : 'items-end')}>
  <input bind:this={fileEl} type="file" multiple hidden onchange={upload} />
  <div class={cn('relative', expanded ? 'w-full' : 'min-w-0 flex-1 order-2')}>
    <textarea
      bind:this={el}
      bind:value={composer.text}
      {oninput}
      {onkeydown}
      rows="1"
      placeholder={ph ?? (chat ? `回复 ${agentName()}…` : '输入文字…')}
      {disabled}
      enterkeyhint={expanded ? 'enter' : 'send'}
      autocapitalize="off"
      {...{ autocorrect: 'off' }}
      spellcheck="false"
      class={cn(
        'block w-full resize-none rounded-[10px] border bg-background py-2 pr-8 pl-2.5 text-base leading-snug outline-none focus:ring-2 focus:ring-ring',
        chat ? 'font-sans' : 'font-mono',
        expanded ? 'h-[38dvh]' : 'max-h-[120px] min-h-[38px]',
      )}
    ></textarea>
    <button
      type="button"
      class="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded text-muted-foreground active:bg-accent"
      aria-label={expanded ? '收起编辑区' : '展开成多行编辑'}
      onpointerdown={(e) => e.preventDefault()}
      onclick={() => { expanded = !expanded; el?.focus() }}
    >{#if expanded}<Minimize2 class="size-3.5" />{:else}<Maximize2 class="size-3.5" />{/if}</button>
  </div>
  <div class={cn('flex gap-1.5', expanded ? 'items-center' : 'contents')}>
    <button
      type="button"
      title="传文件到电脑"
      class={cn('order-1 grid size-[38px] flex-none place-items-center rounded-[10px] border text-muted-foreground', uploading && 'animate-pulse text-primary')}
      onclick={() => fileEl.click()}
    ><Paperclip class="size-4" /></button>
    {#if expanded}<span class="flex-1 text-xs text-muted-foreground">回车换行{chat && !onsubmit ? '，长按发送 = 只填入不提交' : ''}</span>{/if}
    {#if !chat && !onsubmit}
      <button
        type="button"
        title="发送时附带回车"
        aria-pressed={prefs.enter}
        class={cn('order-3 grid size-[38px] flex-none place-items-center rounded-[10px] border text-muted-foreground', prefs.enter && 'border-primary text-primary')}
        onpointerdown={(e) => e.preventDefault()}
        onclick={() => (prefs.enter = !prefs.enter)}
      ><CornerDownLeft class="size-4" /></button>
    {/if}
    <Button type="button" class="order-4 h-[38px] flex-none rounded-[10px] px-3.5 font-semibold select-none" onpointerdown={sendDown} onpointerup={sendUp} onpointercancel={() => clearTimeout(holdTimer)}>发送</Button>
  </div>
</div>
