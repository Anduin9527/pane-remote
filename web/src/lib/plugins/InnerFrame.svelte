<script lang="ts">
  // inner-view 容器：同页，挂在宿主元素的 Shadow DOM 里（DOM 和外壳分开，没有 iframe 的进程和加载开销）。只给 inner-view.ts 注册表里的平台自带视图用。
  import { onMount, untrack } from 'svelte'
  import type { EnterAction, Inst } from './types'
  import { adoptPageStyles, getInnerView } from './inner-view'
  import { backgroundPlugin, closePlugin } from './plugins.svelte'

  let { x }: { x: Inst } = $props()
  let host = $state<HTMLDivElement>()
  const enterFns: Array<(a: EnterAction) => void> = []
  const leaveFns: Array<() => void> = []
  let sentSeq = untrack(() => x.enterSeq)
  let wasFg = untrack(() => x.state === 'fg')

  onMount(() => {
    const view = getInnerView(x.id)
    if (!view || !host) return
    const root = host.attachShadow({ mode: 'open' })
    if (view.pageStyles !== false) adoptPageStyles(root)
    const cleanup = view.mount(root, {
      action: $state.snapshot(x.action) as EnterAction,
      onEnter: (fn) => enterFns.push(fn),
      onLeave: (fn) => leaveFns.push(fn),
      header: (show) => { x.header = show },
      background: () => backgroundPlugin(x.id),
      close: () => closePlugin(x.id),
    })
    return () => { if (wasFg) for (const fn of leaveFns) try { fn() } catch {} ; cleanup?.() }
  })
  // 回到前台（openPlugin 每次都会加 enterSeq）：带上这次的数据调 onEnter
  $effect(() => {
    const seq = x.enterSeq
    if (x.state !== 'fg' || seq === sentSeq) return
    sentSeq = seq
    for (const fn of enterFns) try { fn($state.snapshot(x.action) as EnterAction) } catch (e) { console.error(e) }
  })
  $effect(() => {
    const fg = x.state === 'fg'
    if (wasFg && !fg) for (const fn of leaveFns) try { fn() } catch (e) { console.error(e) }
    wasFg = fg
  })
</script>

<!-- flex 列：视图的根元素用 flex-1 撑满（shadow root 里的元素按宿主的子元素排版） -->
<div bind:this={host} class="absolute inset-0 flex flex-col overflow-auto" inert={x.state !== 'fg'}></div>
