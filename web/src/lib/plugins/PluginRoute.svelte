<script lang="ts">
  // #/plugin/<id> 的页面：插件本身由插件层开在前台、盖在外壳上面，这里只在载入中 / 找不到时露出来
  import { t } from '$lib/i18n'
  import { plugins, info } from './plugins.svelte'

  let { id, onpick }: { id: string; onpick: () => void } = $props()
  const missing = $derived(plugins.loaded && !info(id))
</script>

<div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
  {#if missing}
    <div class="grid gap-3">
      <p class="text-[15px]">{t('还没有这个插件：{id}', { id })}</p>
      <button class="mx-auto h-9 rounded-lg border px-4 text-sm active:bg-accent" onclick={onpick}>{t('选一个会话')}</button>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">{t('正在打开插件…')}</p>
  {/if}
</div>
