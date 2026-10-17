<script lang="ts">
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { toast } from 'svelte-sonner'
  import { manage, type Pane } from '$lib/api'
  import { loadPanes } from '$lib/session.svelte'
  import { t, tr } from '$lib/i18n'

  let { open = $bindable(false), pane }: { open?: boolean; pane: Pane | null } = $props()
  let title = $state('')
  $effect(() => { if (open) title = pane?.tabTitle || '' })

  async function save() {
    if (!pane) return
    try {
      await manage('title', { pane: pane.pane, title })
      open = false
      await loadPanes()
      toast(t('已重命名'))
    } catch (e) { toast.error(t('重命名失败：{msg}', { msg: tr((e as Error).message) })) }
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>{t('重命名标签页')}</Drawer.Title></Drawer.Header>
    <form class="grid gap-3 p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]" onsubmit={(e) => { e.preventDefault(); save() }}>
      <Input bind:value={title} placeholder={t('留空恢复默认标题')} maxlength={80} class="h-10 text-[15px]" />
      <Button type="submit" class="h-10">{t('保存')}</Button>
    </form>
  </Drawer.Content>
</Drawer.Root>
