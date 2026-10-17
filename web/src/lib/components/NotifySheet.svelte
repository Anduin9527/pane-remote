<script lang="ts">
  import * as Drawer from '$lib/components/ui/drawer'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import { Switch } from '$lib/components/ui/switch'
  import { pushSupported, isStandalone, pushStatus, pushEnable, pushDisable, pushTest, getPushPrefs, setPushPrefs } from '$lib/push'

  let { open = $bindable(false), on = $bindable(false) }: { open?: boolean; on?: boolean } = $props()
  let error = $state('')
  let stop = $state(true)
  $effect(() => {
    if (!open) return
    error = ''
    pushStatus().then((v) => (on = v), () => (on = false))
    getPushPrefs().then((p) => (stop = p.stop), () => {})
  })
  async function toggleStop(v: boolean) {
    try { stop = (await setPushPrefs({ stop: v })).stop } catch (e) { toast.error(`保存失败：${(e as Error).message}`) }
  }

  const perm = () => (pushSupported ? Notification.permission : 'default')
  const text = $derived.by(() => {
    if (error) return error
    if (!pushSupported) return isStandalone() ? '这台设备的浏览器不支持网页推送（iOS 需要 16.4 以上）。' : '先点 Safari 的「分享 → 添加到主屏幕」，再从主屏幕图标打开，才能开启通知。'
    if (perm() === 'denied') return '通知权限被拒绝了。到 iPhone「设置 → 通知 → Panes」里打开后再回来。'
    if (on) return '已开启。某个 pane 出现选择器、权限确认或 y/n 提示时会推送；你正在手机上看的 pane、或你最近 2 分钟在用电脑时不推。同一个 pane 15 秒内只推一次。'
    return '开启后，任何 pane 在等你选择或确认时会推送到这台手机，点通知直接打开那个 pane。'
  })

  async function enable() {
    try { on = await pushEnable(); if (on) toast('通知已开启') } catch (e) { error = `开启失败：${(e as Error).message}` }
  }
  async function test() {
    try { const r = await pushTest(); toast(r.sent ? '已发送，切到后台或锁屏看看' : `发送失败（${r.failed} 个订阅失败）`) } catch (e) { toast.error(`发送失败：${(e as Error).message}`) }
  }
  async function disable() {
    try { await pushDisable() } catch {}
    on = await pushStatus().catch(() => false)
    toast('通知已关闭')
  }
</script>

<Drawer.Root bind:open>
  <Drawer.Content>
    <Drawer.Header class="border-b py-3 text-left"><Drawer.Title>推送通知</Drawer.Title></Drawer.Header>
    <p class="p-3.5 text-[13px] leading-relaxed text-muted-foreground">{text}</p>
    {#if on}
      <label class="mx-3.5 mb-3 flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <span>Claude / Codex 一轮做完也推送<span class="block text-xs text-muted-foreground">需要该会话启动时已加载 hook，旧会话重开后才生效</span></span>
        <Switch checked={stop} onCheckedChange={toggleStop} />
      </label>
    {/if}
    <div class="flex flex-wrap gap-2 px-3.5 pb-[calc(env(safe-area-inset-bottom)+14px)]">
      {#if pushSupported && !on && perm() !== 'denied'}<Button onclick={enable}>开启通知</Button>{/if}
      {#if on}
        <Button variant="secondary" onclick={test}>发一条测试</Button>
        <Button variant="secondary" onclick={disable}>关闭通知</Button>
      {/if}
    </div>
  </Drawer.Content>
</Drawer.Root>
