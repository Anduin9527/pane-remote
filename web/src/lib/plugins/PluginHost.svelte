<script lang="ts">
  // 插件层的重的部分（第一次打开抽屉 / 插件时才加载）：抽屉（输入框 + 后台中 / 全部）、插件容器、权限询问、插件在手机上问的问题、权限设置。
  import { tick } from 'svelte'
  import * as Drawer from '$lib/components/ui/drawer'
  import X from '@lucide/svelte/icons/x'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import CircleDot from '@lucide/svelte/icons/circle-dot'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import LogOut from '@lucide/svelte/icons/log-out'
  import Shield from '@lucide/svelte/icons/shield'
  import Search from '@lucide/svelte/icons/search'
  import Moon from '@lucide/svelte/icons/moon'
  import PluginsIcon from './PluginsIcon.svelte'
  import { toast } from 'svelte-sonner'
  import { postJson } from '$lib/api'
  import { cn } from '$lib/utils'
  import { t, tr } from '$lib/i18n'
  import { plugins, info, visible, loadPlugins, openPlugin, closePlugin, backgroundPlugin, requestClose, reloadPlugin } from './plugins.svelte'
  import { platformUi, answerPrompt, answerPluginAsk, warmup } from './client.svelte'
  import { match, actionOf, defaultAction } from './match'
  import PluginFrame from './PluginFrame.svelte'
  import InnerFrame from './InnerFrame.svelte'
  import type { PluginInfo } from './types'

  let query = $state('')
  let input = $state<HTMLInputElement>()
  $effect(() => { if (plugins.drawer) { loadPlugins(true); warmup(); query = '' } })
  // 现在不能用的自带视图（比如服务端没开 screen 模块时的「看屏幕」）不列出来、不匹配
  const list = $derived(visible())
  const hits = $derived(match(list, query).slice(0, 30))
  // 名字、说明也能搜（不算入口，打开时按默认功能进入）
  const byName = $derived(query.trim() ? list.filter((p) => !hits.some((h) => h.plugin.id === p.id) && (p.name + ' ' + p.description).toLowerCase().includes(query.trim().toLowerCase())) : [])
  const others = $derived(plugins.instances.filter((x) => x.state !== 'fg'))
  const RISK: Record<string, string> = { low: t('低风险'), medium: t('中风险'), high: t('高风险') }

  function submit(e: Event) {
    e.preventDefault()
    // 回车：打开第一个命中的入口，输入作为入口数据
    if (hits[0]) openPlugin(hits[0].plugin.id, actionOf(hits[0]))
    else if (byName[0]) openPlugin(byName[0].id)
  }

  const prompt = $derived(platformUi.prompts[0])
  const ask = $derived(platformUi.asks.find((a) => !hiddenAsks.has(a.id)))
  let hiddenAsks = $state(new Set<string>())
  let askText = $state('')
  $effect(() => { ask?.id; askText = '' })

  // ---------- 权限设置 ----------
  type PermRow = { id: string; title: string; description: string; reason: string; decision: 'grant' | 'deny' | 'ask'; remembered: boolean }
  let permOf = $state<PluginInfo | null>(null)
  let permRows = $state<PermRow[]>([])
  let permOpen = $state(false)
  async function openPerms(p: PluginInfo) {
    permOf = p
    permRows = []
    fsDirs = null
    newDir = ''
    permOpen = true
    try { permRows = await (await fetch(`api/plugins/permissions?plugin=${encodeURIComponent(p.id)}`, { cache: 'no-store' })).json() } catch (e) { toast.error((e as Error).message) }
    try { fsDirs = await (await fetch(`api/plugins/fs-dirs?plugin=${encodeURIComponent(p.id)}`, { cache: 'no-store' })).json() } catch {} // ignore: 老服务端没有这个接口，不显示文件夹一节
  }
  // 允许插件读的 Mac 文件夹（platform.fs）：私有目录总是可读；这里加的目录第一次读时还会按目录问一次
  let fsDirs = $state<{ dirs: string[]; private: string } | null>(null)
  let newDir = $state('')
  async function saveDirs(dirs: string[]) {
    if (!permOf) return
    try { fsDirs = await postJson('api/plugins/fs-dirs', { plugin: permOf.id, dirs }); newDir = '' } catch (e) { toast.error(t('保存失败：{msg}', { msg: tr((e as Error).message) })) }
  }
  async function setPerm(row: PermRow, decision: PermRow['decision']) {
    if (!permOf) return
    try { permRows = await postJson('api/plugins/permissions', { plugin: permOf.id, permission: row.id, decision }) } catch (e) { toast.error(t('保存失败：{msg}', { msg: tr((e as Error).message) })) }
  }
  async function resetPerms() {
    if (!permOf) return
    try { permRows = await postJson('api/plugins/permissions', { plugin: permOf.id, reset: true }); toast(t('已重置，下次用到时再问')) } catch (e) { toast.error((e as Error).message) }
  }
  const logo = (p?: PluginInfo) => p?.logo || ''

  // ---------- 胶囊菜单（像微信小程序右上角）：「···」开操作菜单，「⊙」切到后台；退出藏在菜单里，还要再确认一次 ----------
  let menuOf = $state<PluginInfo | null>(null)
  let menuOpen = $state(false)
  const openMenu = (p: PluginInfo) => { menuOf = p; menuOpen = true }
  const menuDo = (fn: () => void) => { menuOpen = false; fn() }
  const closing = $derived(plugins.confirmClose ? info(plugins.confirmClose) : undefined)
</script>

<!-- 插件图标：自带视图的图标组件 > logo 图片 > 默认拼图；big = 列表里的大图标，否则是顶栏的小图标 -->
{#snippet icon(p: PluginInfo | undefined, big: boolean)}
  {#if logo(p) && !p?.icon}<img src={logo(p)} alt="" class={big ? 'size-10 flex-none rounded-xl' : 'size-6 flex-none rounded-md'} />
  {:else}
    <span class={cn('grid flex-none place-items-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary', big ? 'size-10 rounded-xl' : 'size-6 rounded-md')}>
      {#if p?.icon}<p.icon class={big ? 'size-5' : 'size-3.5'} />{:else}<PluginsIcon class={big ? 'size-5' : 'size-3.5'} />{/if}
    </span>
  {/if}
{/snippet}

<!-- 插件容器：挂着页面的都在这里，只有前台那个可见；后台的 invisible + inert（不卸载） -->
{#each plugins.instances.filter((x) => x.loaded) as x (x.id)}
  {@const p = info(x.id)}
  {#if p}
    <!-- 高度跟可视高度走（--vvh）：iOS 键盘弹出时 fixed inset-0 不会变矮，底部输入栏会被键盘盖住 -->
    <section
      class={cn('fixed inset-x-0 top-0 z-40 flex flex-col bg-background', x.state !== 'fg' && 'invisible')}
      style:height="var(--vvh, 100dvh)"
      inert={x.state !== 'fg'}
      aria-hidden={x.state !== 'fg'}
      aria-label={p.name}
      data-plugin={p.id}
      data-state={x.state}
    >
      {#if x.header ?? p.header !== false}
      <!-- 沉浸式顶栏：没有分隔线、半透明，标题居中，右上角胶囊；系统返回手势 = 切到后台 -->
      <header class="flex-none bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div class="relative flex h-11 items-center px-2">
          <div class="flex min-w-0 items-center gap-1.5 pl-1">{@render icon(p, false)}</div>
          <span class="pointer-events-none absolute inset-x-0 mx-auto max-w-[50%] truncate text-center text-[15px] font-semibold">{tr(p.name)}</span>
          <div class="ml-auto flex h-8 items-center rounded-full border border-border/80 bg-card/80 shadow-sm" data-capsule>
            <button class="grid h-full w-11 place-items-center rounded-l-full active:bg-accent" aria-label={t('更多')} onclick={() => openMenu(p)}><Ellipsis class="size-5" /></button>
            <span class="h-4 w-px bg-border"></span>
            <button class="grid h-full w-11 place-items-center rounded-r-full active:bg-accent" aria-label={t('切到后台')} onclick={() => backgroundPlugin(p.id)}><CircleDot class="size-[18px]" /></button>
          </div>
        </div>
      </header>
      {/if}
      <!-- 自带视图自己处理底部安全区（发送栏、按键栏贴底） -->
      <div class={cn('relative min-h-0 flex-1', p.container === 'iframe' && 'pb-[env(safe-area-inset-bottom)]')}>
        {#key x.gen}
          {#if p.container === 'inner-view'}<InnerFrame {x} />{:else}<PluginFrame {x} {p} />{/if}
        {/key}
      </div>
    </section>
  {/if}
{/each}

<Drawer.Root bind:open={plugins.drawer} onOpenChange={(o) => { if (o) tick().then(() => input?.focus({ preventScroll: true })) }}>
  <Drawer.Content class="max-h-[85dvh]">
    <Drawer.Header class="sr-only"><Drawer.Title>{t('插件')}</Drawer.Title></Drawer.Header>
    <form class="flex items-center gap-2 border-b px-3 py-2.5" onsubmit={submit}>
      <Search class="size-4 flex-none text-muted-foreground" />
      <input
        bind:this={input}
        bind:value={query}
        enterkeyhint="go"
        autocomplete="off"
        autocapitalize="off"
        placeholder={t('搜插件，或输入文字交给插件…')}
        aria-label={t('搜插件，或输入文字交给插件…')}
        class="h-9 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
      />
      {#if query}<button type="button" class="grid size-8 place-items-center rounded-md text-muted-foreground" aria-label={t('清空')} onclick={() => (query = '')}><X class="size-4" /></button>{/if}
    </form>
    <div data-vaul-no-drag class="min-h-40 overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom)+12px)]">
      {#if query.trim()}
        {#each hits as h (h.plugin.id + h.code + h.type)}
          <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-accent" onclick={() => openPlugin(h.plugin.id, actionOf(h))}>
            {@render icon(h.plugin, true)}
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{h.type === 'text' ? h.label : `${h.label}：${String(h.payload).slice(0, 40)}`}</span>
              <span class="block truncate text-xs text-muted-foreground">{h.plugin.name}</span>
            </span>
          </button>
        {/each}
        {#each byName as p (p.id)}
          <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-accent" onclick={() => openPlugin(p.id)}>
            {@render icon(p, true)}
            <span class="min-w-0 flex-1"><span class="block truncate text-sm">{tr(p.name)}</span><span class="block truncate text-xs text-muted-foreground">{tr(p.description || '')}</span></span>
          </button>
        {/each}
        {#if !hits.length && !byName.length}<p class="p-6 text-center text-sm text-muted-foreground">{t('没有匹配的插件')}</p>{/if}
      {:else}
        {#if others.length}
          <h3 class="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t('后台中')}</h3>
          {#each others as x (x.id)}
            {@const p = info(x.id)}
            <div class="flex items-center gap-3 px-3 py-2">
              <button class="flex min-w-0 flex-1 items-center gap-3 text-left" onclick={() => openPlugin(x.id, $state.snapshot(x.action))}>
                {@render icon(p, true)}
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{p?.name || x.id}</span>
                  <span class="flex items-center gap-1 text-xs text-muted-foreground">{#if x.state === 'sleep'}<Moon class="size-3" />{t('睡眠中，打开时重新载入')}{:else}{t('后台运行')}{/if}</span>
                </span>
              </button>
              <button class="grid size-8 place-items-center rounded-md text-muted-foreground active:bg-accent" aria-label={t('关闭 {name}', { name: p?.name || x.id })} onclick={() => requestClose(x.id)}><X class="size-4" /></button>
            </div>
          {/each}
        {/if}
        <h3 class="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t('全部')}</h3>
        {#if plugins.error}<p class="px-3 py-2 text-sm text-destructive">{t('读不到插件列表：{msg}', { msg: tr(plugins.error) })}</p>{/if}
        {#if plugins.loaded && !list.length && !plugins.error}<p class="px-3 py-4 text-sm text-muted-foreground">{t('还没有插件。把插件放进服务端的 plugins/ 目录就会出现在这里。')}</p>{/if}
        {#each list as p (p.id)}
          <button class="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-accent" onclick={() => openPlugin(p.id, defaultAction(p))}>
            {@render icon(p, true)}
            <span class="min-w-0 flex-1"><span class="block truncate text-sm">{tr(p.name)}</span><span class="block truncate text-xs text-muted-foreground">{tr(p.description || '')}</span></span>
          </button>
        {/each}
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>

<!-- 权限设置 -->
<Drawer.Root bind:open={permOpen}>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>{t('{name} 的权限', { name: permOf?.name || '' })}</Drawer.Title></Drawer.Header>
    <div data-vaul-no-drag class="max-h-[60dvh] overflow-y-auto overscroll-contain p-3">
      {#if !permRows.length}<p class="py-4 text-center text-sm text-muted-foreground">{t('这个插件还没用过需要权限的功能')}</p>{/if}
      {#each permRows as row (row.id)}
        <div class="mb-2 rounded-lg border p-2.5">
          <div class="text-sm font-medium">{tr(row.title)}</div>
          {#if row.reason}<div class="text-xs text-muted-foreground">{row.reason}</div>{/if}
          <div class="mt-2 flex gap-1.5">
            {#each [['grant', t('允许')], ['ask', t('询问')], ['deny', t('禁止')]] as [d, l] (d)}
              <button class={cn('h-8 flex-1 rounded-md border text-xs', row.decision === d && 'border-primary bg-primary text-primary-foreground')} onclick={() => setPerm(row, d as PermRow['decision'])}>{l}</button>
            {/each}
          </div>
        </div>
      {/each}
      {#if fsDirs}
        <h3 class="mt-3 mb-1 text-xs font-medium text-muted-foreground">{t('可以读的电脑文件夹')}</h3>
        <div class="truncate rounded-lg border px-2.5 py-2 font-mono text-xs text-muted-foreground">{fsDirs.private} · {t('插件私有')}</div>
        {#each fsDirs.dirs as d (d)}
          <div class="mt-1.5 flex items-center gap-2 rounded-lg border px-2.5 py-1">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{d}</span>
            <button class="grid size-7 place-items-center rounded-md text-muted-foreground active:bg-accent" aria-label={t('移除')} onclick={() => saveDirs(fsDirs!.dirs.filter((x) => x !== d))}><X class="size-4" /></button>
          </div>
        {/each}
        <form class="mt-1.5 flex gap-1.5" onsubmit={(e) => { e.preventDefault(); if (newDir.trim()) saveDirs([...fsDirs!.dirs, newDir.trim()]) }}>
          <input bind:value={newDir} placeholder="~/Documents/…" autocapitalize="off" autocomplete="off" class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
          <button disabled={!newDir.trim()} class="h-9 rounded-lg border px-3 text-[13px] disabled:opacity-40">{t('添加')}</button>
        </form>
      {/if}
    </div>
    <div class="flex justify-end border-t p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"><button class="h-9 rounded-lg border px-3 text-sm" onclick={resetPerms}>{t('全部重置为询问')}</button></div>
  </Drawer.Content>
</Drawer.Root>

<!-- 权限询问：插件第一次用某项能力时弹，结果按插件记 -->
{#if prompt}
  <div class="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]" role="dialog" aria-modal="true" aria-label={t('权限询问')}>
    <div class="w-full max-w-md rounded-xl border bg-card p-4 shadow-xl">
      <div class="flex items-center gap-2 text-sm">
        <Shield class={cn('size-4 flex-none', prompt.req.risk === 'high' ? 'text-destructive' : 'text-primary')} />
        <span class="min-w-0 flex-1 font-semibold">{t('「{name}」想要：{perm}', { name: prompt.req.pluginName, perm: tr(prompt.req.title) })}</span>
        <span class="flex-none text-[11px] text-muted-foreground">{RISK[prompt.req.risk] || ''}</span>
      </div>
      {#if prompt.req.description}<p class="mt-1.5 text-[13px] text-muted-foreground">{tr(prompt.req.description)}</p>{/if}
      {#if prompt.req.reason}<p class="mt-1.5 text-[13px]">{t('插件说明：{reason}', { reason: prompt.req.reason })}</p>{/if}
      {#if prompt.req.scope}<p class="mt-1 truncate font-mono text-xs text-muted-foreground">{prompt.req.scope}</p>{/if}
      <div class="mt-3 grid grid-cols-2 gap-2">
        <button class="h-10 rounded-lg border border-primary/50 text-sm active:bg-primary active:text-primary-foreground" onclick={() => answerPrompt(prompt.id, 'once')}>{t('仅本次')}</button>
        <button class="h-10 rounded-lg bg-primary text-sm text-primary-foreground" onclick={() => answerPrompt(prompt.id, 'always')}>{t('始终允许')}</button>
        <button class="h-10 rounded-lg border border-destructive/50 text-sm text-destructive" onclick={() => answerPrompt(prompt.id, 'block')}>{t('禁止')}</button>
        <button class="h-10 rounded-lg border text-sm text-muted-foreground" onclick={() => answerPrompt(prompt.id, 'dismiss')}>{t('以后再说')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- 插件用 platform.agent.ask 问你：和 agent 的 ask_phone 同一种卡片 -->
{#if ask}
  <div class="fixed inset-x-2 top-[calc(env(safe-area-inset-top)+52px)] z-[60] mx-auto max-w-lg rounded-xl border border-primary/40 bg-card p-3 shadow-lg" role="dialog" aria-label={t('{name} 问你', { name: ask.pluginName })}>
    <div class="flex items-center gap-2">
      <PluginsIcon class="size-4 flex-none text-primary" />
      <button class="min-w-0 flex-1 truncate text-left text-xs font-semibold" onclick={() => openPlugin(ask.plugin)}>{t('{name} 问你', { name: ask.pluginName })}</button>
      <button class="grid size-7 place-items-center rounded-md text-muted-foreground active:bg-accent" aria-label={t('稍后')} onclick={() => (hiddenAsks = new Set([...hiddenAsks, ask.id]))}><X class="size-4" /></button>
    </div>
    <p class="mt-1.5 max-h-40 overflow-y-auto text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere]">{ask.question}</p>
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#each ask.options as o (o)}
        <button class="h-9 max-w-full truncate rounded-lg border border-primary/40 px-3 text-[13px] active:bg-primary active:text-primary-foreground" onclick={() => answerPluginAsk(ask.id, o)}>{o}</button>
      {/each}
    </div>
    {#if !ask.confirm}
      <form class="mt-2 flex gap-1.5" onsubmit={(e) => { e.preventDefault(); if (askText.trim()) answerPluginAsk(ask.id, '', askText.trim()) }}>
        <input bind:value={askText} placeholder={t('或者直接写回答…')} class="h-9 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-[13px] outline-none focus:ring-2 focus:ring-ring" />
        <button disabled={!askText.trim()} class="h-9 rounded-lg bg-primary px-3 text-[13px] text-primary-foreground disabled:opacity-40">{t('发送')}</button>
      </form>
    {/if}
  </div>
{/if}

<!-- 胶囊「···」的操作菜单 -->
<Drawer.Root bind:open={menuOpen}>
  <Drawer.Content>
    <Drawer.Header class="flex-row items-center gap-3 border-b py-3 text-left">
      {@render icon(menuOf ?? undefined, true)}
      <div class="min-w-0 text-left"><Drawer.Title class="truncate text-left">{menuOf?.name || ''}</Drawer.Title>{#if menuOf?.description}<p class="truncate text-xs text-muted-foreground">{menuOf.description}</p>{/if}</div>
    </Drawer.Header>
    {#if menuOf}
      {@const m = menuOf}
      <div class="grid grid-cols-4 gap-2 px-3 py-4">
        {#snippet act(Icon: any, label: string, fn: () => void, danger = false)}
          <button class="flex flex-col items-center gap-1.5 text-xs active:opacity-60" onclick={() => menuDo(fn)}>
            <span class={cn('grid size-12 place-items-center rounded-2xl bg-muted', danger && 'bg-destructive/10 text-destructive')}><Icon class="size-5" /></span>
            <span class={cn(danger && 'text-destructive')}>{label}</span>
          </button>
        {/snippet}
        {@render act(CircleDot, t('切到后台'), () => backgroundPlugin(m.id))}
        {@render act(RotateCw, t('重新载入'), () => reloadPlugin(m.id))}
        {#if m.container === 'iframe'}{@render act(Shield, t('权限'), () => openPerms(m))}{/if}
        {@render act(LogOut, t('退出'), () => requestClose(m.id), true)}
      </div>
    {/if}
    <div class="border-t p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"><button class="h-10 w-full rounded-lg bg-muted text-sm" onclick={() => (menuOpen = false)}>{t('取消')}</button></div>
  </Drawer.Content>
</Drawer.Root>

<!-- 退出确认：手机上容易误触 -->
{#if closing}
  <div class="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-6" role="alertdialog" aria-modal="true" aria-label={t('退出插件')}>
    <div class="w-full max-w-xs overflow-hidden rounded-2xl bg-card text-center shadow-xl">
      <div class="px-5 pt-5 pb-4">
        <div class="text-[15px] font-semibold">{t('退出「{name}」？', { name: closing.name })}</div>
        <p class="mt-1.5 text-[13px] text-muted-foreground">{t('页面会关掉，没保存的内容会丢。只是想先离开的话，点右上角的 ⊙ 切到后台。')}</p>
      </div>
      <div class="grid grid-cols-2 border-t text-[15px]">
        <button class="h-11 border-r active:bg-accent" onclick={() => (plugins.confirmClose = '')}>{t('取消')}</button>
        <button class="h-11 font-semibold text-destructive active:bg-accent" onclick={() => { const id = plugins.confirmClose; plugins.confirmClose = ''; closePlugin(id) }}>{t('退出')}</button>
      </div>
    </div>
  </div>
{/if}
