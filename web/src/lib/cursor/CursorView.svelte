<script lang="ts">
  // Cursor 映射：手机上自己的界面，数据来自电脑上的 Cursor（会话列表、消息、状态），操作回传给 Cursor。
  // 不传画面：只同步文字增量，网络差也跟手。项目 = WezTerm 的标签页 / 窗口，会话 = pane。
  import { onMount, onDestroy, tick } from 'svelte'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import { toast } from 'svelte-sonner'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Plus from '@lucide/svelte/icons/plus'
  import Wrench from '@lucide/svelte/icons/wrench'
  import Brain from '@lucide/svelte/icons/brain'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import X from '@lucide/svelte/icons/x'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import GitFork from '@lucide/svelte/icons/git-fork'
  import Pin from '@lucide/svelte/icons/pin'
  import PinOff from '@lucide/svelte/icons/pin-off'
  import Archive from '@lucide/svelte/icons/archive'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import MsgMeta from '$lib/components/MsgMeta.svelte'
  import { Button } from '$lib/components/ui/button'
  import { cn } from '$lib/utils'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import FileDiff from '@lucide/svelte/icons/file-diff'
  import ChangesView from './ChangesView.svelte'
  import UsageCard from './UsageCard.svelte'
  import { resolveLink } from '$lib/links'
  import Composer from '$lib/components/Composer.svelte'
  import { t, tr, isEn } from '$lib/i18n'
  import { cur, connectCursor, disconnectCursor, reconnectCursor, selectSession, startDraft, cursorCmd, sessionById, type CMsg } from './cursor.svelte'

  let { onpreview }: { onpreview?: (url: string) => void } = $props()

  let sheetOpen = $state(false)
  let changesOpen = $state(false)
  let box = $state<HTMLDivElement>()
  let atBottom = $state(true)
  let confirmRestart = $state(false)

  onMount(connectCursor)
  // 还没选会话：接入 Cursor 后自动打开会话选择（只自动打开一次）
  let autoOpened = false
  $effect(() => { if (!autoOpened && cur.conn === 'ready' && !cur.id && !cur.draftProject) { autoOpened = true; sheetOpen = true } })
  onDestroy(disconnectCursor)

  // Markdown 渲染结果缓存（按消息 id + 长度），长对话来回刷新不重复渲染；最多留 500 条
  const mdCache = new Map<string, string>()
  function md(id: string, text: string) {
    const k = `${id}:${text.length}`
    let h = mdCache.get(k)
    if (h === undefined) {
      h = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true, async: false }) as string)
      mdCache.set(k, h)
      if (mdCache.size > 500) mdCache.delete(mdCache.keys().next().value!)
    }
    return h
  }

  type Block = { kind: 'msg'; m: CMsg } | { kind: 'steps'; items: CMsg[] }
  // 连续的工具调用 / 思考合成一行，点开看每一步
  const blocks = $derived.by(() => {
    const out: Block[] = []
    let run: CMsg[] = []
    const flush = () => { if (run.length) out.push({ kind: 'steps', items: run }); run = [] }
    for (const m of cur.list) {
      if (m.role === 'tool' || m.role === 'thinking') run.push(m)
      else { flush(); out.push({ kind: 'msg', m }) }
    }
    flush()
    return out
  })
  const stepSummary = (items: CMsg[]) => {
    const c: Record<string, number> = {}
    for (const m of items) { const n = m.role === 'tool' ? tr(m.tool) : t('思考'); c[n] = (c[n] || 0) + 1 }
    return Object.entries(c).map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(t('、'))
  }
  // 正在生成、数据库里还没有的那段文字（Cursor 页面上的实时内容）
  const streaming = $derived(cur.generating && cur.streamText && !cur.list.some((m) => m.id.split('/')[0] === cur.streamId && m.role === 'assistant' && m.text.length >= cur.streamText.length) ? cur.streamText : '')

  const current = $derived(sessionById(cur.id))
  const project = $derived(cur.projects.find((p) => p.sessions.some((s) => s.id === cur.id)) || cur.projects.find((p) => p.id === cur.draftProject))
  const title = $derived(cur.draftProject ? t('新会话 · {project}', { project: project?.label || t('不选项目') }) : current?.title || cur.name || (cur.id ? t('未命名会话') : t('选择一个会话')))

  $effect(() => { cur.list.length; streaming; if (atBottom) tick().then(() => box?.scrollTo({ top: box.scrollHeight })) })

  // 输入框复用终端那个（草稿按会话存、传文件、展开编辑都一样），发送交给这里
  async function submit(text: string) {
    if (cur.draftProject) await cursorCmd('new', { project: cur.draftProject === '__new__' ? '' : cur.draftProject, text })
    else await cursorCmd('send', { id: cur.id, text })
    atBottom = true
  }
  const draftKey = $derived(cur.draftProject ? `cursor-new:${cur.draftProject}` : cur.id ? `cursor:${cur.id}` : null)
  // 消息里的链接：网页 / 本机文件在预览里打开（跟对话视图一样）
  function onclick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href') || ''
    if (!a || !href) return
    e.preventDefault()
    const url = resolveLink(href, cur.path) // 相对路径按会话的项目目录算
    if (url) onpreview?.(url)
  }
  async function act(cmd: string, body: Record<string, unknown> = {}, ok = '') {
    try { await cursorCmd(cmd, body); if (ok) toast(ok) } catch (err) { toast.error((err as Error).message) }
  }
  // 会话操作：分叉（整段 / 从某一轮）、置顶、归档。分叉成功后切到新会话
  const pinned = $derived(!!cur.projects.find((p) => p.id === '__pinned_agents__')?.sessions.some((s) => s.id === cur.id))
  async function fork(bubble = '') {
    const id = cur.id
    try {
      const r = await cursorCmd('fork', { id, ...(bubble ? { bubble } : {}) })
      if (r.data?.id) { selectSession(r.data.id); toast(bubble ? t('已从这一轮分叉出新会话') : t('已分叉出新会话（带着全部上下文）')) }
    } catch (err) { toast.error(t('分叉失败：{msg}', { msg: (err as Error).message })) }
  }
  let archiveArmed = $state(false)
  async function archive() {
    const id = cur.id
    archiveArmed = false
    try { await cursorCmd('archive', { id }); toast(t('已归档（在 Cursor 里能找回）')); cur.id = ''; sheetOpen = true } catch (err) { toast.error(t('归档失败：{msg}', { msg: (err as Error).message })) }
  }
  // 每一轮的最后一条回复 → 这一轮的用户消息 id（Cursor 的分叉按钮按它定位；同一轮只在最后一条回复下给分叉）
  const turnOf = $derived.by(() => {
    const m = new Map<string, string>()
    let user = '', lastReply = ''
    const close = () => { if (user && lastReply) m.set(lastReply, user) }
    for (const x of cur.list) {
      if (x.role === 'user') { close(); user = x.id; lastReply = '' }
      else if (x.role === 'assistant') lastReply = x.id
    }
    close()
    return m
  })
  function restart() {
    if (!confirmRestart) { confirmRestart = true; setTimeout(() => (confirmRestart = false), 4000); return }
    confirmRestart = false
    act('restart')
  }
  const statusTone = (s: string) => (/complete/i.test(s) ? 'text-ok' : /error|fail|abort/i.test(s) ? 'text-destructive' : /review|approv|wait|input/i.test(s) ? 'text-warn' : s ? 'text-primary' : 'text-muted-foreground')
  // Cursor 的状态标签（比如「Completed, unread」「In progress」）→ 中文；未读用我们自己的蓝点表示
  const statusCn = (st: string) => /in progress|generat|running/i.test(st) ? t('生成中') : /complete/i.test(st) ? t('完成') : /error|fail/i.test(st) ? t('出错') : /abort|cancel/i.test(st) ? t('已中断') : /approv|review|input|wait|permission/i.test(st) ? t('等你') : st.replace(/,\s*unread/i, '')
  const time = (ts: number) => (ts ? new Date(ts).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) : '')
</script>

<div class="flex h-10 flex-none items-center gap-2 border-b bg-card px-2.5">
  <button class="-ml-1 grid size-7 flex-none place-items-center rounded-lg active:bg-accent" aria-label={t('重连 Cursor（{msg}）', { msg: tr(cur.msg) })} onclick={() => { reconnectCursor(); toast(t('重连 Cursor…')) }}>
    <span class={cn('size-2 rounded-full', cur.conn === 'ready' ? 'bg-ok' : cur.conn === 'error' ? 'bg-destructive' : 'bg-muted-foreground', cur.generating && 'animate-pulse bg-primary')}></span>
  </button>
  <button class="flex min-w-0 flex-1 items-center gap-1.5 text-left" onclick={() => (sheetOpen = true)}>
    <span class="min-w-0 truncate text-[14px] font-medium">{title}</span>
    <ChevronDown class="size-4 flex-none text-muted-foreground" />
  </button>
  {#if cur.conn === 'ready'}
    {#if cur.id && cur.path}
      <button class="grid size-8 place-items-center rounded-lg border active:bg-accent" aria-label={t('查看项目文件')} onclick={() => onpreview?.(cur.path + '/')}><FolderOpen class="size-4" /></button>
    {/if}
    {#if cur.id && cur.changed}
      <button class="flex h-8 items-center gap-1 rounded-lg border px-2 text-[13px] active:bg-accent" aria-label={t('查看改动')} onclick={() => (changesOpen = true)}><FileDiff class="size-3.5" />{cur.changed}</button>
    {/if}
    <button class="flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[13px] active:bg-accent" onclick={() => { startDraft(project?.id || ''); }}><Plus class="size-3.5" />{t('新建')}</button>
    {#if cur.id}
      <DropdownMenu.Root onOpenChange={(o) => { if (!o) archiveArmed = false }}>
        <DropdownMenu.Trigger class="grid size-8 place-items-center rounded-lg border active:bg-accent" aria-label={t('会话操作：分叉、置顶、归档')}><Ellipsis class="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-64">
          <DropdownMenu.Item onSelect={() => fork()} disabled={cur.generating}><GitFork />{t('分叉')}<span class="ml-auto text-xs text-muted-foreground">{t('带全部上下文开新会话')}</span></DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => act('pin', { id: cur.id, on: !pinned }, pinned ? t('已取消置顶') : t('已置顶'))}>{#if pinned}<PinOff />{t('取消置顶')}{:else}<Pin />{t('置顶会话')}{/if}</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="destructive" onSelect={(e) => { if (!archiveArmed) { e.preventDefault(); archiveArmed = true; return } archive() }}><Archive />{archiveArmed ? t('再点一次归档') : t('归档')}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  {/if}
</div>

{#if cur.conn !== 'ready'}
  <div class="grid min-h-0 flex-1 place-items-center p-6">
    <div class="grid max-w-sm gap-3 text-center">
      {#if cur.conn === 'not-running'}
        <p class="text-[15px]">{t('电脑上的 Cursor 没有打开')}</p>
        <Button onclick={() => act('launch')} disabled={!!cur.busy}>{cur.busy ? t('启动中…') : t('启动 Cursor')}</Button>
        <p class="text-xs text-muted-foreground">{t('新建会话或发消息时也会自动先启动')}</p>
      {:else if cur.conn === 'no-debug'}
        <p class="text-[15px]">{t('Cursor 开着，但不是用遥控方式启动的')}</p>
        <p class="text-xs text-muted-foreground">{t('要接入它得重启一次 Cursor：先正常退出（有没保存的内容 Cursor 会问你），再带调试端口重新打开，窗口会恢复。正在跑的 Agent 会被打断。')}</p>
        <Button variant={confirmRestart ? 'destructive' : 'default'} onclick={restart} disabled={!!cur.busy}>{cur.busy === 'restart' ? t('重启中…') : confirmRestart ? t('再点一次确认重启') : t('重启并接入')}</Button>
      {:else if cur.conn === 'launching' || cur.conn === 'connecting'}
        <div class="mx-auto size-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        <p class="text-[15px]">{tr(cur.msg) || t('处理中…')}</p>
        {#if cur.step}<div class="flex justify-center gap-1.5">{#each [1, 2, 3] as s (s)}<span class={cn('h-1.5 w-8 rounded-full', (cur.step ?? 0) >= s ? 'bg-primary' : 'bg-muted')}></span>{/each}</div>{/if}
        <p class="text-xs text-muted-foreground">{t('启动 Cursor → 等窗口出来 → 接入')}</p>
      {:else}
        <p class="text-[15px] text-destructive">{tr(cur.msg) || t('出错了')}</p>
        <Button variant="secondary" onclick={() => act('launch')}>{t('重试')}</Button>
      {/if}
    </div>
  </div>
{:else}
  <div class="relative min-h-0 flex-1">
    <div bind:this={box} class="absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3" onscroll={() => { if (box) atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60 }} {onclick} role="presentation">
      {#if !cur.id && !cur.draftProject}
        <p class="p-6 text-center text-sm text-muted-foreground">{t('点上面选一个会话，或者新建')}</p>
      {:else if cur.draftProject}
        <p class="p-6 text-center text-sm text-muted-foreground">{t('写下第一条消息，发送后会在 Cursor 里新建 Agent')}</p>
      {:else if !cur.loaded}
        <p class="p-6 text-center text-sm text-muted-foreground">{t('读取会话…')}</p>
      {/if}
      <div class="grid grid-cols-[minmax(0,1fr)] gap-3">
        {#each blocks as b, i (b.kind === 'msg' ? b.m.id : 's' + i + (b.items[0]?.id || ''))}
          {#if b.kind === 'msg' && b.m.role === 'user'}
            <div class="ml-10 max-w-full min-w-0 justify-self-end rounded-2xl rounded-br-md bg-primary/12 px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{b.m.text}</div>
          {:else if b.kind === 'msg' && b.m.role === 'assistant'}
            <div class="grid min-w-0 gap-1">
              <div class="md min-w-0 text-[15px] leading-relaxed">{@html md(b.m.id, b.m.text)}</div>
              <MsgMeta time={time(b.m.ts)} text={b.m.text} onfork={turnOf.get(b.m.id) && !cur.generating ? () => fork(turnOf.get(b.m.id)) : undefined} />
            </div>
          {:else if b.kind === 'steps'}
            <details class="min-w-0 rounded-lg border bg-card text-xs">
              <summary class="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5">
                <Wrench class="size-3.5 flex-none text-muted-foreground" />
                <span class="flex-none font-medium">{t('{n} 步', { n: b.items.length })}</span>
                <span class="min-w-0 truncate text-muted-foreground">{stepSummary(b.items)}</span>
              </summary>
              <div class="grid gap-1 border-t p-1.5">
                {#each b.items as s (s.id)}
                  {#if s.role === 'tool' && (s.output || s.error)}
                    <!-- 执行命令：点开看命令、目录和输出（Cursor 的 Terminal 面板） -->
                    <details class="min-w-0 rounded-md">
                      <summary class="flex min-w-0 cursor-pointer list-none items-center gap-1.5 px-1.5 py-1">
                        <Wrench class={cn('size-3 flex-none', s.rejected || s.error ? 'text-destructive' : 'text-muted-foreground')} />
                        <span class="flex-none font-medium">{tr(s.tool)}</span>
                        <span class="min-w-0 truncate font-mono text-muted-foreground">{s.detail}</span>
                        {#if s.rejected}<span class="ml-auto flex-none text-destructive">{t('被拒绝')}</span>{:else if s.error}<span class="ml-auto flex-none text-destructive">{t('出错')}</span>{/if}
                      </summary>
                      {#if s.cwd}<p class="px-2 font-mono text-[10.5px] text-muted-foreground">{s.cwd}</p>{/if}
                      <pre class="mx-1.5 mb-1.5 max-h-72 overflow-auto rounded bg-[#1a1b26] px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all text-[#c0caf5]">{s.error || s.output || t('（没有输出）')}</pre>
                    </details>
                  {:else}
                  <div class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1">
                    {#if s.role === 'tool'}
                      <Wrench class="size-3 flex-none text-muted-foreground" />
                      <span class="flex-none font-medium">{tr(s.tool)}</span>
                      <span class="min-w-0 truncate font-mono text-muted-foreground">{s.detail}</span>
                      {#if s.decision}<span class="ml-auto flex-none text-muted-foreground">{s.decision}</span>{/if}
                    {:else if s.role === 'thinking'}
                      <Brain class="size-3 flex-none text-muted-foreground" />
                      <span class="text-muted-foreground">{t('思考了 {n} 字', { n: s.size > 999 ? (s.size / 1000).toFixed(1) + 'k' : s.size })}</span>
                    {/if}
                  </div>
                  {/if}
                {/each}
              </div>
            </details>
          {/if}
        {/each}
        {#if streaming}
          <div class="md min-w-0 text-[15px] leading-relaxed opacity-90">{@html md('stream', streaming)}</div>
        {/if}

      </div>
    </div>
    {#if !atBottom}
      <button class="absolute right-3.5 bottom-3 grid size-10 place-items-center rounded-full border bg-card shadow-lg" aria-label={t('回到底部')} onclick={() => box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })}><ArrowDown class="size-4" /></button>
    {/if}
  </div>

  <div class="border-t bg-card pb-[env(safe-area-inset-bottom)]">
    {#if cur.choices.length}
      <div class="flex flex-wrap gap-1.5 px-2.5 pt-2">
        <span class="self-center text-xs text-warn">{t('Cursor 在等你：')}</span>
        {#each cur.choices as c (c)}<button class="h-8 rounded-lg border bg-secondary px-3 text-[13px] active:bg-accent" onclick={() => act('choose', { label: c })}>{c}</button>{/each}
      </div>
    {/if}
    <!-- 跟终端对话模式一样：在跑的时候给一条「正在工作… 停止」 -->
    {#if cur.generating}
      <div class="flex items-center gap-2 border-b px-3 py-1.5 text-sm">
        <span class="flex-1 animate-pulse text-primary">{t('Cursor 正在工作…')}</span>
        <button class="h-7 rounded-md border px-2.5 text-[13px] active:bg-accent" onclick={() => act('stop', {}, t('已让 Cursor 停下'))}>{t('停止')}</button>
      </div>
    {/if}
    <Composer chat {draftKey} onsubmit={submit} disabled={!cur.id && !cur.draftProject} placeholder={cur.draftProject ? t('新会话的第一条消息…') : cur.id ? t('发给 Cursor…') : t('先选一个会话')} />
  </div>
{/if}

<ChangesView bind:open={changesOpen} id={cur.id} title={title} onfiles={(p) => onpreview?.(p)} />

<!-- 会话选择：全屏页（不用可拖动的抽屉，那种容器会把列表滚动当成拖动拦截掉） -->
{#if sheetOpen}
  <div class="fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
    <header class="flex flex-none items-center gap-2 border-b bg-card px-2 py-2">
      <button class="grid size-9 place-items-center rounded-lg active:bg-accent" aria-label={t('关闭')} onclick={() => (sheetOpen = false)}><X class="size-5" /></button>
      <strong class="flex-1">{t('Cursor 会话列表')}</strong>
      <Button size="sm" variant="secondary" class="h-9 rounded-full" onclick={() => { startDraft(''); sheetOpen = false }}><Plus />{t('新对话')}</Button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pt-2 pb-[calc(env(safe-area-inset-bottom)+12px)]" data-testid="cursor-sessions">
      <UsageCard />
      {#if !cur.projects.length}<p class="p-6 text-center text-sm text-muted-foreground">{cur.conn === 'ready' ? t('没有会话') : tr(cur.msg) || t('还没接入 Cursor')}</p>{/if}
      <div class="grid gap-3">
        {#each cur.projects as p (p.id)}
          {#if p.sessions.length || p.uri}
            <section class="grid gap-0.5">
              <div class="flex items-center justify-between px-2.5 text-xs text-muted-foreground">
                <span class="truncate">{tr(p.label)}</span>
                {#if p.uri}<button class="flex items-center gap-0.5 rounded px-1.5 py-1 text-primary active:bg-accent" onclick={() => { startDraft(p.id); sheetOpen = false }}><Plus class="size-3" />{t('新 Agent')}</button>{/if}
              </div>
              {#each p.sessions as s (s.id)}
                <button class={cn('flex min-w-0 items-center gap-2 rounded-[10px] px-2.5 py-3 text-left active:bg-accent', s.id === cur.id && 'bg-accent')} onclick={() => { selectSession(s.id); sheetOpen = false }}>
                  <span class={cn('size-2 flex-none rounded-full', s.unread ? 'bg-primary' : 'bg-transparent')} aria-label={s.unread ? t('未读') : undefined}></span>
                  <span class={cn('min-w-0 flex-1 truncate text-[15px]', s.unread && 'font-semibold')}>{s.title || t('无标题')}</span>
                  {#if s.waiting}<span class="flex-none rounded-full bg-warn px-1.5 text-[10px] leading-4 font-semibold text-black">{t('等你')}</span>{/if}
                  {#if s.active}<span class="flex-none rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">{t('电脑上开着')}</span>{/if}
                  <span class={cn('flex-none text-xs', statusTone(s.status))}>{statusCn(s.status)}</span>
                  <span class="w-8 flex-none text-right text-xs text-muted-foreground">{s.age}</span>
                </button>
              {/each}
            </section>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}
