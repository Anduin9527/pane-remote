<script lang="ts">
  // 自定义快捷键：显示/隐藏、上下移动、加宏（一段文字，可选附带回车），恢复默认
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import { DEFAULT_KEYS, withNewDefaults, isPinned, type Key } from '$lib/keys'
  import Pin from '@lucide/svelte/icons/pin'
  import PinOff from '@lucide/svelte/icons/pin-off'
  import { prefs } from '$lib/prefs.svelte'
  import { cn } from '$lib/utils'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let list = $state<Key[]>([])
  let mLabel = $state('')
  let mText = $state('')
  let mEnter = $state(true)
  $effect(() => { if (open) list = structuredClone($state.snapshot(prefs.keys ? withNewDefaults(prefs.keys) : DEFAULT_KEYS)) })

  const commit = () => { prefs.keys = structuredClone($state.snapshot(list)) }
  function move(i: number, d: number) {
    const j = i + d
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    commit()
  }
  function toggle(i: number) { list[i].hidden = !list[i].hidden; commit() }
  // 放到第一行 / 收进「⋯」面板
  function pin(i: number) { list[i].pinned = !isPinned(list[i]); commit() }
  function remove(i: number) { list.splice(i, 1); commit() }
  function addMacro(e: Event) {
    e.preventDefault()
    const text = mText.replace(/\n/g, '\r')
    if (!text) return
    list.unshift({ label: (mLabel.trim() || mText.trim()).slice(0, 12), seq: text, macro: true, enter: mEnter })
    commit()
    mLabel = ''; mText = ''
  }
  function reset() { prefs.keys = null; list = structuredClone(DEFAULT_KEYS) }
  const show = (k: Key) => (k.macro ? `${k.seq.replace(/\r/g, '⏎')}${k.enter ? ' ⏎' : ''}` : '')
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[90dvh]">
    <Drawer.Header class="flex-row items-center justify-between border-b py-3">
      <Drawer.Title>快捷键</Drawer.Title>
      <Button variant="ghost" size="sm" onclick={reset}>恢复默认</Button>
    </Drawer.Header>
    <form class="grid gap-2 border-b p-3.5" onsubmit={addMacro}>
      <p class="text-xs text-muted-foreground">图钉亮着的键放在第一行，其余收在「⋯」里。加一个宏：点一下就发出这段文字，比如 /compact、git status</p>
      <div class="flex gap-2">
        <Input bind:value={mText} placeholder="要发送的文字" autocapitalize="off" spellcheck={false} class="h-10 flex-1 font-mono" />
        <Input bind:value={mLabel} placeholder="按钮名" maxlength={12} class="h-10 w-24" />
      </div>
      <div class="flex items-center justify-between">
        <label class="flex items-center gap-2 text-sm"><Switch bind:checked={mEnter} /> 发送后按回车</label>
        <Button type="submit" size="sm" disabled={!mText}>添加</Button>
      </div>
    </form>
    <div class="overflow-y-auto overscroll-contain px-2 pb-[calc(env(safe-area-inset-bottom)+10px)]">
      {#each list as k, i (i)}
        <div class={cn('flex items-center gap-1 rounded-lg px-1.5 py-1', k.hidden && 'opacity-45')}>
          <span class="min-w-14 rounded-md border bg-secondary px-2 py-1 text-center font-mono text-[13px]">{k.label}</span>
          <span class="min-w-0 flex-1 truncate px-1 font-mono text-xs text-muted-foreground">{show(k)}</span>
          <Button variant="ghost" size="icon" aria-label={isPinned(k) ? '移出第一行' : '放到第一行'} class={isPinned(k) ? 'text-primary' : ''} onclick={() => pin(i)}>
            {#if isPinned(k)}<Pin />{:else}<PinOff />{/if}
          </Button>
          <Button variant="ghost" size="icon" aria-label="上移" onclick={() => move(i, -1)} disabled={i === 0}><ArrowUp /></Button>
          <Button variant="ghost" size="icon" aria-label="下移" onclick={() => move(i, 1)} disabled={i === list.length - 1}><ArrowDown /></Button>
          {#if k.macro}
            <Button variant="ghost" size="icon" aria-label="删除" class="text-destructive" onclick={() => remove(i)}><Trash2 /></Button>
          {:else}
            <Button variant="ghost" size="icon" aria-label={k.hidden ? '显示' : '隐藏'} onclick={() => toggle(i)}>
              {#if k.hidden}<EyeOff />{:else}<Eye />{/if}
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  </Drawer.Content>
</Drawer.Root>
