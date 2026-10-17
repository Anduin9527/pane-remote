<script lang="ts">
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { toast } from 'svelte-sonner'
  import { manage, type Pane } from '$lib/api'
  import { loadPanes } from '$lib/session.svelte'

  let { open = $bindable(false), pane }: { open?: boolean; pane: Pane | null } = $props()
  let title = $state('')
  $effect(() => { if (open) title = pane?.tabTitle || '' })

  async function save() {
    if (!pane) return
    try {
      await manage('title', { pane: pane.pane, title })
      open = false
      await loadPanes()
      toast('已重命名')
    } catch (e) { toast.error(`重命名失败：${(e as Error).message}`) }
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>重命名标签页</Drawer.Title></Drawer.Header>
    <form class="grid gap-3 p-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]" onsubmit={(e) => { e.preventDefault(); save() }}>
      <Input bind:value={title} placeholder="留空恢复默认标题" maxlength={80} class="h-10 text-[15px]" />
      <Button type="submit" class="h-10">保存</Button>
    </form>
  </Drawer.Content>
</Drawer.Root>
