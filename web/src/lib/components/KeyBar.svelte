<script lang="ts">
  // 快捷键：第一行放最常用的几个（排满一行不用滑），其余收在「⋯」展开的面板里（自动换行，也不用滑）。
  // 按键在手指抬起时才生效，中途移动超过 8px 就取消；方向键、退格这类按住 350ms 后连发。
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { sendRaw } from '$lib/api'
  import { DEFAULT_KEYS, withNewDefaults, isPinned, type Key } from '$lib/keys'
  import { mods, withMods } from '$lib/mods.svelte'
  import { prefs } from '$lib/prefs.svelte'
  import { ui } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import Joystick from './Joystick.svelte'
  import { t } from '$lib/i18n'

  let { ctrl = $bindable(false), onedit }: { ctrl?: boolean; onedit: () => void } = $props()
  const all = $derived((prefs.keys ? withNewDefaults(prefs.keys) : DEFAULT_KEYS).filter((k) => !k.hidden))
  const top = $derived(all.filter(isPinned))
  const rest = $derived(all.filter((k) => !isPinned(k)))
  let open = $state(false)
  // 「⋯」：轻点展开 / 收起，长按打开快捷键编辑（编辑入口不常驻）
  let moreTimer: ReturnType<typeof setTimeout> | undefined
  let moreHeld = false
  function moreDown(e: PointerEvent) {
    e.preventDefault()
    moreHeld = false
    moreTimer = setTimeout(() => { moreHeld = true; navigator.vibrate?.(10); onedit() }, 550)
  }
  function moreUp() {
    clearTimeout(moreTimer)
    if (!moreHeld) open = !open
  }
  // 面板里有亮着的修饰键时在「⋯」上提示
  const restActive = $derived(ctrl || mods.shift || mods.alt)

  let press: { k: Key; x: number; y: number; fired: boolean } | null = null
  let holdTimer: ReturnType<typeof setTimeout> | undefined, repeatTimer: ReturnType<typeof setInterval> | undefined
  function cancel() { clearTimeout(holdTimer); clearInterval(repeatTimer); press = null }

  function activate(k: Key) {
    if (k.seq === 'ctrl') { ctrl = !ctrl; return }
    if (k.seq === 'shift') { mods.shift = !mods.shift; return }
    if (k.seq === 'alt') { mods.alt = !mods.alt; return }
    if (k.macro) {
      sendRaw(ui.current, k.seq, false)
      if (k.enter) sendRaw(ui.current, '\r', false) // 单独一个请求，Claude Code 不会当成粘贴
      return
    }
    sendRaw(ui.current, withMods(k.seq)) // ⇧ / ⌥ 亮着时套上修饰键
  }
  function down(e: PointerEvent, k: Key) {
    e.preventDefault() // 不抢输入框焦点，键盘不收起
    cancel()
    press = { k, x: e.clientX, y: e.clientY, fired: false }
    if (k.repeat) holdTimer = setTimeout(() => {
      if (!press) return
      press.fired = true
      const seq = withMods(k.seq)
      sendRaw(ui.current, seq)
      repeatTimer = setInterval(() => sendRaw(ui.current, seq), 90)
    }, 350)
  }
  function move(e: PointerEvent) {
    if (press && (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8)) cancel()
  }
  function up() {
    if (press && !press.fired) activate(press.k)
    cancel()
  }
  const lit = (k: Key) => (k.seq === 'ctrl' && ctrl) || (k.seq === 'shift' && mods.shift) || (k.seq === 'alt' && mods.alt)
  const keyCls = (k: Key) => cn(
    'h-9 touch-manipulation rounded-lg border bg-secondary px-1 font-mono text-[13px] select-none active:bg-primary active:text-primary-foreground',
    k.macro && 'border-primary/40 font-sans',
    lit(k) && 'border-transparent bg-primary text-primary-foreground',
  )
</script>

<div class="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
  <Joystick />
  <div class="grid min-w-0 flex-1 gap-1" style:grid-template-columns="repeat({top.length}, minmax(0, 1fr))">
    {#each top as k, i (i)}
      <button type="button" class={cn(keyCls(k), 'min-w-0 truncate')} onpointerdown={(e) => down(e, k)} onpointermove={move} onpointerup={up} onpointercancel={cancel}>{k.label}</button>
    {/each}
  </div>
  <!-- 展开 / 收起：和按键区分开（没有边框和底色）；长按打开快捷键编辑 -->
  <button
    type="button"
    aria-label={open ? t('收起更多按键（长按编辑）') : t('更多按键（长按编辑）')}
    aria-expanded={open}
    class={cn('relative grid h-9 w-8 flex-none place-items-center rounded-full text-muted-foreground active:bg-accent', open && 'text-foreground')}
    onpointerdown={moreDown}
    onpointerup={moreUp}
    onpointercancel={() => clearTimeout(moreTimer)}
  >
    {#if open}<ChevronDown class="size-4" />{:else}<Ellipsis class="size-4" />{/if}
    {#if restActive && !open}<span class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"></span>{/if}
  </button>
</div>
{#if open}
  <div class="grid grid-cols-[repeat(auto-fill,minmax(52px,1fr))] gap-1 px-2.5 pt-0.5 pb-1.5">
    {#each rest as k, i (i)}
      <button type="button" class={cn(keyCls(k), 'truncate px-1.5')} onpointerdown={(e) => down(e, k)} onpointermove={move} onpointerup={up} onpointercancel={cancel}>{k.label}</button>
    {/each}
  </div>
{/if}
