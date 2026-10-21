// inner-view 容器：同页、挂在 Shadow DOM 里的平台自带视图（预览、这台电脑、看屏幕这类要和外壳共享连接、手势、性能敏感的功能）。
// 白名单就是这张注册表：只有编进前端的代码能 registerInnerView，服务端列表里的插件一律走 iframe。
// 和 iframe 插件一样有前台 / 后台 / 睡眠 / 关闭：后台时宿主元素 inert + 隐藏，睡眠或关闭时调 mount 返回的清理函数。
// Shadow DOM 只隔开视图和外壳的 DOM：外壳的样式表（Tailwind）默认也套进去（adoptPageStyles），视图直接用同一套 class。
import type { Component } from 'svelte'
import type { EnterAction } from './types'

export type InnerViewCtx = {
  /** 进入时的数据；之后再带新数据进入会调 onEnter */
  action: EnterAction
  /** 回到前台（带新数据进入也算） */
  onEnter(fn: (a: EnterAction) => void): void
  /** 切到后台（不卸载） */
  onLeave(fn: () => void): void
  /** 显示 / 隐藏平台的插件顶栏（全屏类的视图自己画顶栏） */
  header(show: boolean): void
  /** 收到后台（隐藏不卸载） */
  background(): void
  close(): void
}

/** 功能指令：文字，或者带好拼音的文字（前端不带拼音库，中文指令的全拼 / 首字母写在这里） */
export type InnerCmd = string | { label: string; py?: string; pyi?: string }

export type InnerView = {
  id: string
  name: string
  description?: string
  /** 功能指令（抽屉里按它匹配） */
  cmds?: InnerCmd[]
  logo?: string
  /** 抽屉里的图标（编进前端的图标组件，优先于 logo） */
  icon?: Component
  /** 后台多少秒后睡眠，默认 300 */
  keepAlive?: number
  /** 显示平台的插件顶栏，默认 true；运行中可以用 ctx.header 改 */
  header?: boolean
  /** 现在能不能用（比如要服务端加载了某个扩展）：不能用时不出现在抽屉里，地址直接打开照常进 */
  available?: () => boolean
  /** 把外壳的样式表套进 shadow root，默认 true */
  pageStyles?: boolean
  /** 把视图挂到 shadow root 上，返回清理函数 */
  mount(root: ShadowRoot, ctx: InnerViewCtx): (() => void) | void
}

const views = new Map<string, InnerView>()
let listeners: Array<() => void> = []

export function registerInnerView(v: InnerView) {
  views.set(v.id, v)
  refreshInnerViews()
}
/** 注册表没变、但 available() 的结果可能变了（扩展列表读到了）：让插件列表重新算一遍 */
export function refreshInnerViews() { for (const fn of listeners) fn() }
export const getInnerView = (id: string) => views.get(id)
export const innerViews = () => [...views.values()]
export function onInnerViewsChange(fn: () => void) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn) } }

// ---------- 外壳样式套进 shadow root ----------
// 每张页面样式表复制成一份可共享的 CSSStyleSheet（同一张只复制一次，所有 inner-view 共用）。
// 按需加载的分块带来的样式表晚到：视图组件下载完再调一次，补上新的。
const copies = new WeakMap<CSSStyleSheet, CSSStyleSheet>()
export function adoptPageStyles(root: ShadowRoot) {
  const out: CSSStyleSheet[] = []
  for (const s of document.styleSheets) {
    let c = copies.get(s)
    if (!c) {
      try {
        c = new CSSStyleSheet()
        c.replaceSync([...s.cssRules].map((r) => r.cssText).join('\n'))
        copies.set(s, c)
      } catch { continue } // 跨域的表读不了 cssRules（外壳没有这种）
    }
    out.push(c)
  }
  root.adoptedStyleSheets = out
}
