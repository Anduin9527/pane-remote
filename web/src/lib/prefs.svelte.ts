import type { Key } from './keys'

// 手机本地偏好（localStorage），和旧版同名同 key，切到新版后设置不丢
function load<T>(k: string, d: T): T {
  try { const v = localStorage.getItem(k); return v === null ? d : (JSON.parse(v) as T) } catch { return d }
}
function save(k: string, v: unknown) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch {}
}

export const prefs = $state({
  pane: load<string | null>('pane', null),
  fs: load('fs', 12),
  fit: load('fit', true),
  enter: load('enter', true),
  lastCmd: load('lastCmd', ''),
  inject: load('inject', true), // 新开 / 分叉 agent 时注入 pane-remote 插件
  keys: load<Key[] | null>('keys', null), // null = 用默认键位
})

$effect.root(() => {
  $effect(() => save('pane', prefs.pane))
  $effect(() => save('fs', prefs.fs))
  $effect(() => save('fit', prefs.fit))
  $effect(() => save('enter', prefs.enter))
  $effect(() => save('lastCmd', prefs.lastCmd))
  $effect(() => save('inject', prefs.inject))
  $effect(() => save('keys', $state.snapshot(prefs.keys)))
})
