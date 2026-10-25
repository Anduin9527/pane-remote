<script lang="ts" module>
  // 底部要让出来的高度（发送栏、快捷键栏）：外壳知道确切高度时可以调 setPluginDockInset 更新
  export const pluginDock = $state({ bottom: 160 })
  export const setPluginDockInset = (px: number) => { pluginDock.bottom = Math.max(0, Math.round(px)) }
</script>

<script lang="ts">
  import { load } from '$lib/lazy'
  // 插件层：全局悬浮按钮（可拖到左右边缘，位置存在这台手机上；有后台插件时显示数量）→ 底部抽屉 → 插件容器。
  // 首屏只有这个按钮；抽屉、容器、权限询问在第一次用到时才加载（PluginHost.svelte）。挂在 App.svelte 最后。
  import { onMount, untrack, type Component } from 'svelte'
  import PluginsIcon from './PluginsIcon.svelte'
  import { cn } from '$lib/utils'
  import { t } from '$lib/i18n'
  import { plugins, backgroundCount, foreground, openPlugin, backgroundPlugin } from './plugins.svelte'
  import './builtin.svelte' // 平台自带的插件：预览、这台电脑、看屏幕
  import { route, navigate, type View } from '$lib/router.svelte'
  import { platformUi, warmup } from './client.svelte'

  const SIZE = 44
  const KEY = 'plugins.fab'
  let pos = $state<{ side: 'left' | 'right'; y: number }>((() => { try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && (v.side === 'left' || v.side === 'right') && Number.isFinite(v.y)) return v } catch {} return { side: 'right', y: -1 } })())
  let vh = $state(innerHeight)
  let vw = $state(innerWidth)
  let drag = $state<{ x: number; y: number; sx: number; sy: number; moved: boolean } | null>(null)
  const top = 64
  const maxY = $derived(Math.max(top, vh - pluginDock.bottom - SIZE))
  const y = $derived(Math.min(maxY, Math.max(top, drag ? drag.y : pos.y < 0 ? maxY - 24 : pos.y)))

  let Host = $state<Component | null>(null)
  const need = $derived(plugins.drawer || plugins.instances.length > 0 || platformUi.asks.length > 0 || platformUi.prompts.length > 0)
  $effect(() => { if (need && !Host) load(() => import('./PluginHost.svelte')).then((m) => (Host = m.default)) })
  // 晚一点连上平台：插件之前在手机上问的、还没答的问题能显示出来
  onMount(() => { const id = setTimeout(warmup, 4000); return () => clearTimeout(id) })

  // ---------- 地址 ↔ 前台插件 ----------
  // #/plugin/<id> → 打开到前台；地址离开插件 → 前台插件切后台；插件到前台 → 地址跟上；前台插件切后台 / 关掉 → 回到打开插件之前的视图（换掉这条历史，不用后退，免得冷启动时退出 App）
  const ours = (v: View) => v.kind === 'plugin'
  let before: View = { kind: 'none' }
  $effect(() => {
    const v = route.view
    if (!ours(v)) {
      before = $state.snapshot(v) as View
      // 地址离开了插件（返回手势、推送跳到会话、选了别的会话）：前台的插件切到后台，不然它还盖在上面
      untrack(() => { const fg = foreground(); if (fg) backgroundPlugin(fg.id) })
      return
    }
    untrack(() => { if (foreground()?.id !== (v as { id: string }).id) openPlugin((v as { id: string }).id) })
  })
  let prevFg = ''
  $effect(() => {
    const fg = foreground()?.id || ''
    untrack(() => {
      const v = route.view
      if (fg && !(v.kind === 'plugin' && v.id === fg)) navigate({ view: { kind: 'plugin', id: fg }, sheet: '', open: '' })
      else if (!fg && prevFg && v.kind === 'plugin' && v.id === prevFg) navigate({ view: before, sheet: '', open: '' }, { replace: true })
      prevFg = fg
    })
  })

  const count = $derived(backgroundCount())
  const hidden = $derived(!!foreground() || plugins.drawer)

  function down(e: PointerEvent) {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag = { x: e.clientX, y, sx: e.clientX, sy: e.clientY, moved: false }
  }
  function move(e: PointerEvent) {
    if (!drag) return
    const moved = drag.moved || Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 6
    if (moved) drag = { ...drag, x: e.clientX, y: Math.min(maxY, Math.max(top, e.clientY - SIZE / 2)), moved }
  }
  function up() {
    if (!drag) return
    const d = drag
    drag = null
    if (!d.moved) { plugins.drawer = true; return }
    pos = { side: d.x < vw / 2 ? 'left' : 'right', y: Math.min(maxY, Math.max(top, d.y)) }
    try { localStorage.setItem(KEY, JSON.stringify(pos)) } catch {}
  }
</script>

<svelte:window bind:innerHeight={vh} bind:innerWidth={vw} />

{#if !hidden}
  <button
    class={cn(
      'fixed z-30 grid touch-none place-items-center rounded-full bg-gradient-to-br from-primary to-primary/75 text-primary-foreground shadow-[0_6px_20px_-4px] shadow-primary/50 ring-1 ring-white/15 select-none active:scale-95',
      !drag && 'transition-[top,left,right] duration-200',
    )}
    style:width="{SIZE}px"
    style:height="{SIZE}px"
    style:top="{y}px"
    style:left={drag?.moved ? `${Math.min(vw - SIZE, Math.max(0, drag.x - SIZE / 2))}px` : pos.side === 'left' ? 'calc(env(safe-area-inset-left) + 6px)' : 'auto'}
    style:right={!drag?.moved && pos.side === 'right' ? 'calc(env(safe-area-inset-right) + 6px)' : 'auto'}
    aria-label={count ? t('插件（{n} 个在后台）', { n: count }) : t('插件')}
    data-plugin-fab
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={() => (drag = null)}
  >
    <PluginsIcon class="size-5" />
    {#if count}<span class="absolute -top-1 -right-1 grid h-4.5 min-w-4.5 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-background">{count}</span>{/if}
  </button>
{/if}

{#if Host}<Host />{/if}
