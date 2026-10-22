<script lang="ts">
  // 「更多 → 更新内容」：当前版本号 + CHANGELOG.md（中转的 api/changelog）
  import * as Drawer from '$lib/components/ui/drawer'
  import { marked } from 'marked'
  import DOMPurify from 'dompurify'
  import { t } from '$lib/i18n'
  import { APP_VERSION } from '$lib/version'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  let html = $state('')
  let error = $state('')
  $effect(() => {
    if (!open || html) return
    fetch('api/changelog', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      // 去掉文件开头的标题和说明，从第一个版本开始
      .then((md) => {
        md = md.slice(Math.max(0, md.search(/^## \[/m))).replace(/^## \[Unreleased\]\s*(?=^## )/m, '') // 空的 Unreleased 不显示
        html = DOMPurify.sanitize(marked.parse(md, { gfm: true, async: false }) as string)
      })
      .catch((e) => (error = t('读不到更新记录：{msg}', { msg: (e as Error).message })))
  })
</script>

<Drawer.Root bind:open>
  <Drawer.Content class="max-h-[85dvh]">
    <Drawer.Header class="border-b py-3 text-left">
      <Drawer.Title>{t('更新内容')}</Drawer.Title>
      <Drawer.Description>{t('当前版本 v{v}', { v: APP_VERSION })}</Drawer.Description>
    </Drawer.Header>
    <div class="md changelog overflow-y-auto px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+16px)] text-sm leading-relaxed">
      {#if error}<p class="text-muted-foreground">{error}</p>{:else if html}{@html html}{:else}<p class="text-muted-foreground">{t('加载中…')}</p>{/if}
    </div>
  </Drawer.Content>
</Drawer.Root>

<style>
  .changelog :global(h2) { margin: 1.25rem 0 0.25rem; font-size: 1rem; font-weight: 600; }
  .changelog :global(h3) { margin: 0.75rem 0 0.25rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted-foreground); }
  .changelog :global(ul) { margin: 0; padding-left: 1.1rem; list-style: disc; }
  .changelog :global(li) { margin: 0.15rem 0; }
  .changelog :global(a) { text-decoration: underline; }
</style>
