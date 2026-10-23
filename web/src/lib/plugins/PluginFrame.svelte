<script lang="ts">
  // iframe 容器：sandbox 只给 allow-scripts allow-forms（没有 allow-same-origin，插件页是不透明来源，碰不到外壳的存储和接口）。
  // 插件页里的运行时（platform/runtime.js）经 postMessage 发调用；按消息来自哪个 iframe 认插件，插件自己说是谁不算数。
  // 进入：页面就绪后、以及每次带新数据回到前台时发 enter；切后台发 leave。
  import { onDestroy, untrack } from 'svelte'
  import type { Inst, PluginInfo } from './types'
  import { onFrameMessage } from './plugins.svelte'
  import { onPluginDb } from './client.svelte'

  let { x, p }: { x: Inst; p: PluginInfo } = $props()
  let frame = $state<HTMLIFrameElement>()
  let ready = $state(false)
  let sentSeq = 0
  let wasFg = untrack(() => x.state === 'fg')

  // 插件页是不透明来源，targetOrigin 只能写 *；消息只发给这个 iframe 自己的 window
  const post = (msg: object) => frame?.contentWindow?.postMessage({ __paneRemote: 1, ...msg }, '*')

  function onMessage(ev: MessageEvent) {
    if (!frame || ev.source !== frame.contentWindow || ev.data?.__paneRemote !== 1) return
    const m = ev.data
    if (m.t === 'ready') { ready = true; return }
    onFrameMessage(p.id, m, post)
  }

  $effect(() => {
    const seq = x.enterSeq
    if (!ready || x.state !== 'fg' || sentSeq === seq) return
    sentSeq = seq
    post({ t: 'enter', action: $state.snapshot(x.action) })
  })
  $effect(() => {
    const fg = x.state === 'fg'
    if (wasFg && !fg && ready) post({ t: 'leave' })
    wasFg = fg
  })
  // 插件数据在别处改了：转给插件页的本地副本（它按 rev 合并，再调 onDbPull 的回调）
  const offDb = onPluginDb({ plugin: untrack(() => p.id), docs: (docs) => post({ t: 'db', docs }), resync: () => post({ t: 'resync' }) })
  onDestroy(() => { offDb(); if (ready) post({ t: 'leave' }) })
</script>

<svelte:window onmessage={onMessage} />
<iframe
  bind:this={frame}
  src={p.main}
  title={p.name}
  sandbox="allow-scripts allow-forms"
  referrerpolicy="no-referrer"
  class="absolute inset-0 size-full border-0 bg-background"
  inert={x.state !== 'fg'}
></iframe>
