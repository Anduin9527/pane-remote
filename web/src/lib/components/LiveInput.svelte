<script lang="ts" module>
  export type Mod = 'Meta' | 'Alt' | 'Control' | 'Shift'
  /** 快捷键：key 用 KeyboardEvent.key 的名字（Enter、ArrowLeft、单个字符…），mods 是一起按的修饰键；mod 表示这是个修饰键开关（只对下一个键生效） */
  export type LiveKey = { label: string; key?: string; mods?: Mod[]; mod?: Mod }
  export const MOD_LABEL: Record<Mod, string> = { Meta: '⌘', Alt: '⌥', Control: '⌃', Shift: '⇧' }
</script>

<script lang="ts">
  // 实时输入栏（远程桌面、浏览器预览共用）：每打一个字直接发过去，不用先打完再点「发送」。
  // 输入法：拼写中不发，上屏时（compositionend）整段发一次；iOS 拼完还会再来一个 insertFromComposition / insertText，去重。
  // 上面一行快捷键（排满一行不用滑），其余收在「⋯」里；修饰键是开关，点了只对下一个键生效。
  // 手机键盘弹着时底部不留安全区（不然键盘和输入框中间空一截）
  import { cn } from '$lib/utils'
  import { t } from '$lib/i18n'

  let {
    top,
    more = [],
    onkey,
    ontext,
    placeholder,
    dark = false,
    keys = 'always',
    safeBottom = true,
    input = $bindable(),
    focused = $bindable(false),
  }: {
    top: LiveKey[]
    more?: LiveKey[]
    onkey: (key: string, mods: Mod[]) => void
    ontext: (s: string) => void
    placeholder: string
    dark?: boolean
    /** always：一直显示快捷键；focus：输入框有焦点（键盘弹着）时才显示 */
    keys?: 'always' | 'focus'
    safeBottom?: boolean
    input?: HTMLInputElement
    focused?: boolean
  } = $props()

  let mods = $state<Mod[]>([])
  let moreOpen = $state(false)
  const moreModOn = $derived(more.some((k) => k.mod && mods.includes(k.mod)))
  const showKeys = $derived(keys === 'always' || focused)

  let kbUp = $state(false)
  $effect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const f = () => (kbUp = window.innerHeight - vv.height > 120)
    f()
    vv.addEventListener('resize', f)
    return () => vv.removeEventListener('resize', f)
  })

  function key(k: string, extra: Mod[] = []) {
    onkey(k, [...new Set([...mods, ...extra])])
    mods = []
  }
  // 按着修饰键时文字逐个按键发（⌘ 再打 c = ⌘C），否则整段
  function text(s: string) {
    if (!mods.length) return ontext(s)
    for (const ch of s) key(ch === '\n' ? 'Enter' : ch)
  }
  function hit(k: LiveKey) {
    if (k.mod) mods = mods.includes(k.mod) ? mods.filter((m) => m !== k.mod) : [...mods, k.mod]
    else if (k.key) key(k.key, k.mods)
  }

  let composedAt = 0, composedText = ''
  function onBeforeInput(e: InputEvent) {
    if (e.inputType === 'insertCompositionText' || e.inputType === 'deleteCompositionText' || e.inputType === 'insertFromComposition') return
    e.preventDefault()
    if (e.inputType === 'deleteContentBackward') key('Backspace')
    else if (e.inputType === 'deleteContentForward') key('Delete')
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') key('Enter')
    else if (e.inputType === 'insertFromPaste') { const s = e.data ?? e.dataTransfer?.getData('text/plain'); if (s) text(s) } // 手机这边粘贴：把手机剪贴板的文字发过去
    else if (e.data) {
      // 有的输入法拼完后又用 insertText 把同一段再插一遍
      if (e.data === composedText && Date.now() - composedAt < 300) return
      text(e.data)
    }
  }
  function onCompositionEnd(e: CompositionEvent) {
    if (e.data) { text(e.data); composedText = e.data; composedAt = Date.now() }
    // 等这一轮输入事件走完再清空，免得打断输入法
    setTimeout(() => { if (input) input.value = '' })
  }
  const PASS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'])
  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return
    // 外接键盘：带 ⌘ / ⌃ / ⌥ 的组合键原样发过去
    const held: Mod[] = (['Meta', 'Alt', 'Control', 'Shift'] as Mod[]).filter((m) => e.getModifierState(m))
    if (PASS.has(e.key)) { e.preventDefault(); key(e.key, held) }
    // ⌘V 留给手机本地粘贴（上面的 insertFromPaste）
    else if (e.key.length === 1 && held.some((m) => m !== 'Shift') && !(held.includes('Meta') && e.key.toLowerCase() === 'v')) { e.preventDefault(); key(e.key.toLowerCase(), held) }
  }

  const btn = $derived(dark ? 'bg-white/10 text-white active:bg-white/25' : 'bg-muted text-foreground active:bg-accent')
</script>

{#if showKeys}
  <div class="flex items-center gap-1 px-2 pt-1.5">
    <div class="grid min-w-0 flex-1 gap-1" style:grid-template-columns="repeat({top.length}, minmax(0, 1fr))">
      {#each top as k (k.label)}
        <button type="button" class={cn('h-9 min-w-0 rounded-md px-0 text-[13px]', btn, k.mod && mods.includes(k.mod) && 'bg-primary text-primary-foreground')} onpointerdown={(e) => e.preventDefault()} onclick={() => hit(k)}>{k.label}</button>
      {/each}
    </div>
    {#if more.length}
      <button type="button" class={cn('relative grid h-9 w-8 flex-none place-items-center rounded-md', dark ? 'text-white/70 active:bg-white/25' : 'text-muted-foreground active:bg-accent', moreOpen && (dark ? 'bg-white/15 text-white' : 'bg-accent text-foreground'))} aria-label={t('更多按键')} onpointerdown={(e) => e.preventDefault()} onclick={() => (moreOpen = !moreOpen)}>
        ⋯{#if moreModOn && !moreOpen}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"></span>{/if}
      </button>
    {/if}
  </div>
  {#if moreOpen}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1 px-2 pt-1">
      {#each more as k (k.label)}
        <button type="button" class={cn('h-9 min-w-0 rounded-md px-1 text-[13px]', btn, k.mod && mods.includes(k.mod) && 'bg-primary text-primary-foreground')} onpointerdown={(e) => e.preventDefault()} onclick={() => hit(k)}>{k.label}</button>
      {/each}
    </div>
  {/if}
{/if}
<div class={cn('px-2 pt-1.5', !safeBottom || kbUp ? 'pb-1.5' : 'pb-[calc(env(safe-area-inset-bottom)+6px)]')}>
  <input bind:this={input} onbeforeinput={onBeforeInput} oncompositionend={onCompositionEnd} onkeydown={onKeyDown}
    onfocus={() => (focused = true)} onblur={() => (focused = false)}
    autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="enter" {...{ autocorrect: 'off' }}
    placeholder={mods.length ? t('按下一个键（带 {m}）', { m: mods.map((m) => MOD_LABEL[m]).join('') }) : placeholder}
    class={cn('h-10 w-full rounded-lg border px-3 text-base outline-none', dark ? 'border-white/20 bg-white/10 text-white placeholder:text-white/40' : 'bg-background focus:ring-2 focus:ring-ring')} />
</div>
