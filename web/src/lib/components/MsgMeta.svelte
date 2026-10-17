<script lang="ts">
  // 回复下面的一行：时间 + 复制（Claude / Codex 对话视图和 Cursor 视图共用，两边保持一致）；Cursor 还能从这一轮分叉
  import { toast } from 'svelte-sonner'
  import Copy from '@lucide/svelte/icons/copy'
  import GitFork from '@lucide/svelte/icons/git-fork'
  import { t } from '$lib/i18n'
  let { time, text, onfork }: { time: string; text: string; onfork?: () => void } = $props()
  function copy() { navigator.clipboard.writeText(text).then(() => toast(t('已复制')), () => toast.error(t('复制失败'))) }
</script>

<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
  <span>{time}</span>
  {#if text}<button class="flex items-center gap-0.5 rounded px-1 py-0.5 active:bg-accent" aria-label={t('复制这条回复')} onclick={copy}><Copy class="size-3" />{t('复制')}</button>{/if}
  {#if onfork}<button class="flex items-center gap-0.5 rounded px-1 py-0.5 active:bg-accent" aria-label={t('从这一轮分叉出新会话')} onclick={onfork}><GitFork class="size-3" />{t('从这里分叉')}</button>{/if}
</div>
