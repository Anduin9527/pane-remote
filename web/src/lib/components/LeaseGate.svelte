<script lang="ts">
  // 被顶 / 在被遥控的电脑上打开时盖住整个界面（见 lib/lease.svelte.ts）。被顶的可以点「在这台设备上继续」顶回去
  import { lease, takeOver } from '$lib/lease.svelte'
  import { t } from '$lib/i18n'
  import { Button } from '$lib/components/ui/button'
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone'
  import MonitorOff from '@lucide/svelte/icons/monitor-off'

  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
    return s < 60 ? t('刚刚') : s < 3600 ? t('{n} 分钟前', { n: Math.round(s / 60) }) : t('{n} 小时前', { n: Math.round(s / 3600) })
  }
</script>

{#if lease.status === 'kicked' || lease.status === 'local'}
  <div class="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4 bg-background px-8 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center" role="alertdialog" aria-modal="true">
    {#if lease.status === 'kicked'}
      <MonitorSmartphone class="size-12 text-muted-foreground" />
      <div class="text-lg font-medium">{lease.device ? t('已在「{d}」上打开', { d: lease.device }) : t('已在另一台设备上打开')}</div>
      <p class="max-w-xs text-sm text-muted-foreground">
        {t('同一时间只能在一台设备上使用，这里已经断开。')}{#if lease.since}<br />{ago(lease.since)}{/if}
      </p>
      <Button size="lg" onclick={takeOver}>{t('在这台设备上继续')}</Button>
    {:else}
      <MonitorOff class="size-12 text-muted-foreground" />
      <div class="text-lg font-medium">{t('这台电脑就是被遥控的电脑')}</div>
      <p class="max-w-xs text-sm text-muted-foreground">{t('请用手机或其他设备打开。')}</p>
    {/if}
  </div>
{/if}
