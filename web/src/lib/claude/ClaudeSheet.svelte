<script lang="ts">
  // Claude 会话操作：分叉当前会话到新 pane（带着上下文开一个新会话）、同目录新开 Claude、常用斜杠命令
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import { manage, sendRaw } from '$lib/api'
  import { ui, loadPanes, select, agentName } from '$lib/session.svelte'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let busy = $state('')
  const account = $derived(ui.claude?.agent === 'claude' ? (ui.claude?.configDir || '').split('/').pop()?.replace(/^\.claude-?/, '') || t('默认') : '')
  // 各 agent 的常用斜杠命令（不确定支持的就不放）
  const COMMANDS_BY_AGENT: Record<string, string[]> = {
    claude: ['/compact', '/clear', '/context', '/model', '/cost', '/resume', '/rewind', '/agents'],
    codex: ['/compact', '/new', '/model', '/status', '/diff', '/review', '/init'],
  }
  const COMMANDS = $derived(COMMANDS_BY_AGENT[ui.claude?.agent ?? ''] ?? [])
  const canFork = $derived(ui.claude?.agent !== 'cursor-agent')

  async function spawn(mode: 'fork' | 'new', where: 'right' | 'bottom' | 'tab') {
    if (!ui.current) return
    busy = `${mode}-${where}`
    try {
      const { pane } = await manage<{ pane: number }>('claude', { pane: Number(ui.current), mode, where })
      open = false
      toast(mode === 'fork' ? t('已分叉到新 pane（新会话，带着原来的上下文）') : t('已新开 {agent}', { agent: agentName() }))
      await loadPanes()
      select(pane)
    } catch (e) {
      toast.error(t('没成功：{msg}', { msg: tr((e as Error).message) }))
    } finally {
      busy = ''
    }
  }
  function run(c: string) {
    sendRaw(ui.current, c, false)
    sendRaw(ui.current, '\r', false) // 单独一个请求，Claude Code 不会当成粘贴
    open = false
  }
  const WHERE = [['right', t('右侧拆分')], ['bottom', t('下方拆分')], ['tab', t('新标签')]] as const
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left">
      <Drawer.Title>{t('{agent} 会话', { agent: agentName() })}</Drawer.Title>
      {#if ui.claude}
        <Drawer.Description class="flex items-center gap-2 font-mono text-xs">
          <span class="truncate">{ui.claude.session.slice(0, 8)}{account ? ` · ${t('账号 {name}', { name: account })}` : ''}</span>
          <button class="text-primary" onclick={() => navigator.clipboard.writeText(ui.claude!.session).then(() => toast(t('已复制会话 ID')))}>{t('复制 ID')}</button>
        </Drawer.Description>
      {/if}
    </Drawer.Header>
    <div class="grid gap-4 p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]">
      {#if canFork}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('分叉当前会话')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('新会话带着现在的全部上下文，原会话不受影响')}</span></span>
        <div class="grid grid-cols-3 gap-1.5">
          {#each WHERE as [w, l] (w)}<Button variant="secondary" disabled={!!busy} onclick={() => spawn('fork', w)}>{busy === `fork-${w}` ? '…' : l}</Button>{/each}
        </div>
      </section>
      {/if}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('同目录新开 {agent}', { agent: agentName() })}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('全新会话')}</span></span>
        <div class="grid grid-cols-3 gap-1.5">
          {#each WHERE as [w, l] (w)}<Button variant="secondary" disabled={!!busy} onclick={() => spawn('new', w)}>{busy === `new-${w}` ? '…' : l}</Button>{/each}
        </div>
      </section>
      {#if COMMANDS.length}
      <section class="grid gap-2">
        <span class="text-sm font-medium">{t('常用命令')}<span class="ml-1.5 text-xs font-normal text-muted-foreground">{t('发到当前会话')}</span></span>
        <div class="flex flex-wrap gap-1.5">
          {#each COMMANDS as c (c)}<button class="h-9 rounded-lg border bg-secondary px-3 font-mono text-[13px] active:bg-primary active:text-primary-foreground" onclick={() => run(c)}>{c}</button>{/each}
        </div>
      </section>
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
