<script lang="ts">
  // 从手机调 pane 在电脑上的宽度：电脑上图方便把它拖窄了，手机上看就挤成一条。
  // 调的是电脑上的分隔线（相邻 pane 至少留 12 列），电脑屏幕上会跟着变
  import * as Drawer from '$lib/components/ui/drawer'
  import { toast } from 'svelte-sonner'
  import { manage, label, type Pane } from '$lib/api'
  import { loadPanes } from '$lib/session.svelte'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false), pane }: { open?: boolean; pane: Pane | null } = $props()

  const FONT = 'Menlo, "SF Mono", ui-monospace, "PingFang SC", monospace'
  // 手机上 12px 字一行能放下的列数（跟终端画面同一套字体）
  const phoneCols = (() => {
    const c = document.createElement('canvas').getContext('2d')!
    c.font = `100px ${FONT}`
    const ratio = c.measureText('MMMMMMMMMM').width / 1000
    return Math.max(40, Math.floor((window.innerWidth - 12) / (12 * ratio)) - 1)
  })()

  let cols = $state(0)
  let busy = $state('')
  $effect(() => { if (open && pane) { cols = pane.cols; busy = '' } })

  async function apply(key: string, width: number | 'eq') {
    const p = pane
    if (!p || busy) return
    busy = key
    try {
      const r = await manage<{ cols: number | null }>('width', { pane: p.pane, width })
      if (r.cols != null) cols = r.cols
      const limited = width !== 'eq' && r.cols != null && r.cols !== width
      toast(limited ? t('调到了 {n} 列（相邻 pane 至少要留 12 列）', { n: r.cols }) : t('已调到 {n} 列', { n: r.cols ?? '?' }))
      loadPanes().catch(() => {})
    } catch (e) { toast.error(t('调整失败：{msg}', { msg: tr((e as Error).message) })) }
    finally { busy = '' }
  }

  const btn = 'h-11 rounded-lg border bg-secondary text-[14px] active:bg-accent disabled:opacity-50'
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    {#if pane}
      <Drawer.Header class="border-b py-3 text-left">
        <Drawer.Title class="truncate">{t('电脑上的宽度')} · #{pane.pane} {label(pane)}</Drawer.Title>
        <Drawer.Description>{t('现在 {n} 列。调的是电脑上的分隔线，电脑屏幕会跟着变', { n: cols })}</Drawer.Description>
      </Drawer.Header>
      <div class="grid gap-2 p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]">
        <button class="h-11 rounded-lg bg-primary text-[14px] font-medium text-primary-foreground active:bg-primary/90 disabled:opacity-50" disabled={!!busy} onclick={() => apply('phone', phoneCols)}>
          {busy === 'phone' ? '…' : t('适合手机（{n} 列）', { n: phoneCols })}
        </button>
        <div class="grid grid-cols-3 gap-2">
          <button class={btn} disabled={!!busy || cols - 10 < 12} onclick={() => apply('minus', Math.max(12, cols - 10))}>{busy === 'minus' ? '…' : t('窄 10 列')}</button>
          <button class={btn} disabled={!!busy} onclick={() => apply('plus', cols + 10)}>{busy === 'plus' ? '…' : t('宽 10 列')}</button>
          <button class={btn} disabled={!!busy} onclick={() => apply('eq', 'eq')}>{busy === 'eq' ? '…' : t('均分')}</button>
        </div>
        <p class="text-xs text-muted-foreground">{t('「均分」按拆分把这个标签页里的所有 pane 分匀（左右、上下都调）')}</p>
      </div>
    {/if}
  </Drawer.Content>
</Drawer.Root>
