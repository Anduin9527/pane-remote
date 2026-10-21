<script lang="ts">
  // 插件入口的图标：三个圆角方块 + 右上角一个圆点（「应用格」的意思），悬浮按钮、菜单、默认插件图标共用
  let { class: cls = '' }: { class?: string } = $props()
</script>

<svg class={cls} viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <rect x="3.5" y="3.5" width="7" height="7" rx="2.2" fill="currentColor" />
  <rect x="3.5" y="13.5" width="7" height="7" rx="2.2" fill="currentColor" />
  <rect x="13.5" y="13.5" width="7" height="7" rx="2.2" fill="currentColor" />
  <circle cx="17" cy="7" r="3.6" fill="currentColor" opacity=".55" />
</svg>
