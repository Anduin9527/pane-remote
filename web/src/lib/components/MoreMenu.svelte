<script lang="ts">
  // 顶栏的更多菜单。菜单组件（bits-ui + 浮层定位）不小，App 第一次点「⋯」时才下载这个文件，下载完直接展开
  import Bell from '@lucide/svelte/icons/bell'
  import BellOff from '@lucide/svelte/icons/bell-off'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import MoveHorizontal from '@lucide/svelte/icons/move-horizontal'
  import Columns3 from '@lucide/svelte/icons/columns-3'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Languages from '@lucide/svelte/icons/languages'
  import FileText from '@lucide/svelte/icons/file-text'
  import History from '@lucide/svelte/icons/history'
  import { APP_VERSION } from '$lib/version'
  import PluginsIcon from '$lib/plugins/PluginsIcon.svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { incidents } from '$lib/incidents.svelte'
  import { prefs } from '$lib/prefs.svelte'
  import { ui } from '$lib/session.svelte'
  import { cn } from '$lib/utils'
  import { t, isEn, setLang } from '$lib/i18n'

  let { open = $bindable(false), class: className = '', onPane, pushOn, onplugins, onreader, onwidth, onincident, onnotify, onchangelog }: {
    open?: boolean; class?: string; onPane: boolean; pushOn: boolean
    onplugins: () => void; onreader: () => void; onwidth: () => void; onincident: () => void; onnotify: () => void; onchangelog: () => void
  } = $props()

  function zoom(d: number) {
    prefs.fit = false
    prefs.fs = Math.min(22, Math.max(6, Math.round(prefs.fs) + d))
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger class={cn(className, 'relative')} aria-label={t('更多：阅读、字号、通知、语言')}>
    <Ellipsis class="size-4" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-64">
    <!-- 预览、这台电脑、看屏幕都是插件了：这里打开插件抽屉（和悬浮按钮一样） -->
    <DropdownMenu.Item onSelect={onplugins}><PluginsIcon class="size-4 text-muted-foreground" />{t('插件')}<span class="ml-auto text-xs text-muted-foreground">{t('预览、这台电脑、看屏幕…')}</span></DropdownMenu.Item>
    <DropdownMenu.Separator />
    {#if onPane}
      <DropdownMenu.Item onSelect={onreader}><FileText />{t('阅读模式')}<span class="ml-auto text-xs text-muted-foreground">{t('复制、搜索、链接')}</span></DropdownMenu.Item>
      <div class="flex items-center gap-1.5 px-1.5 py-1 text-sm">
        <span class="flex-1">{t('字号 {n}', { n: prefs.fs })}</span>
        <button class="h-7 w-9 rounded-md border active:bg-accent" aria-label={t('缩小字号')} onclick={() => zoom(-1)}>A−</button>
        <button class="h-7 w-9 rounded-md border active:bg-accent" aria-label={t('放大字号')} onclick={() => zoom(1)}>A+</button>
      </div>
      <DropdownMenu.Item onSelect={(e) => { e.preventDefault(); prefs.fit = !prefs.fit }}><MoveHorizontal />{t('适配屏幕宽度')}<span class="ml-auto text-xs {prefs.fit ? 'text-ok' : 'text-muted-foreground'}">{prefs.fit ? t('开') : t('关')}</span></DropdownMenu.Item>
      <DropdownMenu.Item onSelect={onwidth}><Columns3 />{t('电脑上的宽度')}<span class="ml-auto text-xs text-muted-foreground">{t('{n} 列', { n: ui.cols })}</span></DropdownMenu.Item>
    {/if}
    <DropdownMenu.Item onSelect={onincident}><TriangleAlert />{t('问题报告')}<span class="ml-auto text-xs text-muted-foreground">{incidents.open ? t('{n} 个待处理', { n: incidents.open }) : t('报告问题')}</span></DropdownMenu.Item>
    <DropdownMenu.Item onSelect={onnotify}>{#if pushOn}<Bell />{:else}<BellOff />{/if}{t('推送通知')}<span class="ml-auto text-xs text-muted-foreground">{pushOn ? t('已开') : t('未开')}</span></DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={() => setLang(isEn ? 'zh' : 'en')}><Languages />{t('语言')}<span class="ml-auto text-xs text-muted-foreground">{isEn ? 'English → 中文' : '中文 → English'}</span></DropdownMenu.Item>
    <DropdownMenu.Item onSelect={onchangelog}><History />{t('更新内容')}<span class="ml-auto font-mono text-xs text-muted-foreground">v{APP_VERSION}</span></DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
