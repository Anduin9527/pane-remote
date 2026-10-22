<script lang="ts">
  // Cursor 映射：手机上自己的界面，数据来自电脑上的 Cursor（消息、状态），操作回传给 Cursor。
  // 不传画面：只同步文字增量，网络差也跟手。会话列表在统一的会话列表（PaneSheet）里，这里只是选中 Cursor 会话时的对话视图。
  import ModelChip from '$lib/components/ModelChip.svelte'
  import { onMount, tick } from 'svelte'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import { toast } from 'svelte-sonner'
  import CursorIcon from './CursorIcon.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Wrench from '@lucide/svelte/icons/wrench'
  import Brain from '@lucide/svelte/icons/brain'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
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
  import Repeat from '@lucide/svelte/icons/repeat'
  import ChangesView from './ChangesView.svelte'
  import { resolveLink } from '$lib/links'
  import Composer from '$lib/components/Composer.svelte'
  import { t, tr, isEn } from '$lib/i18n'
  import { cur, holdCursor, selectSession, startDraft, cursorCmd, sessionById, type CMsg } from './cursor.svelte'
  import { cursorSessions } from '$lib/sessions.svelte'

  // onpick：打开会话列表（App 里统一的那个）
  let { onpreview, onpick }: { onpreview?: (url: string) => void; onpick?: () => void } = $props()

  let changesOpen = $state(false)
  let box = $state<HTMLDivElement>()
  let atBottom = $state(true)
  let confirmRestart = $state(false)

  onMount(() => holdCursor('watch'))
  // 还没选会话：接入 Cursor 后自动打开会话列表（只自动打开一次）
  let autoOpened = false
  $effect(() => { if (!autoOpened && cur.conn === 'ready' && !cur.id && !cur.draftProject) { autoOpened = true; onpick?.() } })

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
  const title = $derived(cursorSessions.title())
  // loop 倒计时：每 15 秒刷新一次显示
  let nowTick = $state(Date.now())
  onMount(() => { const h = setInterval(() => (nowTick = Date.now()), 15000); return () => clearInterval(h) })
  const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const every = (s: number) => (s >= 3600 && s % 3600 === 0 ? t('{n} 小时', { n: s / 3600 }) : s >= 60 && s % 60 === 0 ? t('{n} 分钟', { n: s / 60 }) : t('{n} 秒', { n: s }))
  function loopLine(l: { state: string; interval: number; fixed: boolean }) {
    const base = l.interval ? t('Loop · 每 {e}', { e: every(l.interval) }) : 'Loop'
    return l.state === 'waiting' ? base : `${base} · ${t('已停')}`
  }
  function loopIn(at: number) {
    const left = Math.max(0, Math.round((at - nowTick) / 60000))
    return left >= 1 ? `${hm(at)}（${t('{n} 分钟后', { n: left })}）` : hm(at)
  }

  $effect(() => { cur.list.length; streaming; if (atBottom) tick().then(() => box?.scrollTo({ top: box.scrollHeight })) })

  // 输入框复用终端那个（草稿按会话存、传文件、展开编辑都一样），发送交给这里
  async function submit(text: string) {
    await cursorSessions.send(text)
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
  // 分叉会在 Cursor 里新开一个会话、把电脑上的窗口切过去：先弹一次确认，免得误触
  function fork(bubble = '') {
    toast(bubble ? t('从这一轮分叉出新会话？') : t('分叉出新会话（带着全部上下文）？'), { description: t('会在电脑上的 Cursor 里新开一个会话并切过去'), action: { label: t('分叉'), onClick: () => doFork(bubble) }, duration: 6000 })
  }
  async function doFork(bubble = '') {
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
    try { await cursorCmd('archive', { id }); toast(t('已归档（在 Cursor 里能找回）')); cur.id = ''; onpick?.() } catch (err) { toast.error(t('归档失败：{msg}', { msg: (err as Error).message })) }
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

<!-- 会话栏：会话名和连接状态在顶栏，这里是 Cursor 会话自己的操作 -->
<div class="flex h-10 flex-none items-center gap-2 border-b bg-card px-2.5">
  <span class="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-muted-foreground"><CursorIcon class="size-3.5 flex-none" /><span class={cn('truncate', statusTone(current?.status || ''))}>{current ? statusCn(current.status) : 'Cursor'}</span></span>
  {#if cur.id}<ModelChip cursor={cur.id} />{/if}
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
    <!-- /loop：电脑上 Cursor 在跑的循环（后台终端里定时叫醒 agent），点开看完整说明 -->
    {#each cur.loops as l (l.purpose)}
      <details class="border-b px-3 py-1.5 text-sm">
        <summary class="flex cursor-pointer list-none items-center gap-2">
          <Repeat class={cn('size-3.5 flex-none', l.state === 'waiting' ? 'text-primary' : 'text-muted-foreground')} />
          <span class="min-w-0 flex-1 truncate">{loopLine(l)}</span>
          <span class="flex-none text-xs text-muted-foreground">{l.state === 'waiting' && l.nextAt ? t('下次 {at}', { at: loopIn(l.nextAt) }) : l.lastTickAt ? t('上次 {at}', { at: hm(l.lastTickAt) }) : ''}</span>
        </summary>
        <div class="mt-1 space-y-0.5 pl-5.5 text-xs text-muted-foreground">
          {#if l.title}<div>{l.title}</div>{/if}
          {#if l.prompt}<div class="break-words whitespace-pre-wrap text-foreground/80">{l.prompt}</div>{/if}
          <div>{t('已触发 {n} 次', { n: l.ticks })}{l.state === 'stopped' ? ' · ' + t('电脑上没在等下一次（可能已停止，或 agent 正在处理这一次）') : ''}</div>
        </div>
      </details>
    {/each}
    {#if cur.generating}
      <div class="flex items-center gap-2 border-b px-3 py-1.5 text-sm">
        <span class="flex-1 animate-pulse text-primary">{t('Cursor 正在工作…')}</span>
        <button class="h-7 rounded-md border px-2.5 text-[13px] active:bg-accent" onclick={() => cursorSessions.stop().then(() => toast(t('已让 Cursor 停下')), (err) => toast.error((err as Error).message))}>{t('停止')}</button>
      </div>
    {/if}
    <Composer chat {draftKey} onsubmit={submit} disabled={!cur.id && !cur.draftProject} placeholder={cur.draftProject ? t('新会话的第一条消息…') : cur.id ? t('发给 Cursor…') : t('先选一个会话')} />
  </div>
{/if}

<ChangesView bind:open={changesOpen} id={cur.id} title={title} onfiles={(p) => onpreview?.(p)} />
