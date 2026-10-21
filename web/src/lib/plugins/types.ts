// 插件平台前端的类型：和 platform/catalog.mjs 的 /api/plugins 列表一一对应
import type { Component } from 'svelte'
export type Cmd = { type: string; label: string; py?: string; pyi?: string; match?: string; exclude?: string; minLength?: number; maxLength?: number }
export type Feature = { code: string; description: string; cmds: Cmd[] }
export type PluginInfo = {
  id: string
  name: string
  version: string
  description: string
  logo: string
  main: string
  /** iframe：目录里的插件；inner-view：编进前端的平台自带视图（白名单就是 inner-view.ts 的注册表） */
  container: 'iframe' | 'inner-view'
  /** 后台超过这么多秒就睡眠 */
  keepAlive: number
  format: string
  permissions: Record<string, { reason?: string }>
  features: Feature[]
  /** 以下只有前端自带的 inner-view 有：图标组件、默认显不显示插件顶栏、现在不能用（不出现在抽屉里） */
  icon?: Component
  header?: boolean
  hidden?: boolean
}
/** 进入插件时带的数据（whatevertools 的 action / uTools 的 onPluginEnter 参数） */
export type EnterAction = { code: string; type: string; payload: unknown; from: string }
/** 前台（显示中）/ 后台（隐藏但不卸载）/ 睡眠（卸载了，重新打开要重载） */
export type InstState = 'fg' | 'bg' | 'sleep'
export type Inst = {
  id: string
  state: InstState
  /** 当前挂着页面（睡眠时为 false） */
  loaded: boolean
  /** 每次重新载入加一，作为 {#key}，保证睡眠后恢复是真的重载 */
  gen: number
  /** 每次带新数据进入加一：容器据此再发一次 enter */
  enterSeq: number
  action: EnterAction
  lastUsed: number
  bgSince: number
  /** 视图运行中改过插件顶栏的显示（inner-view 的 ctx.header）；没改过按 PluginInfo.header */
  header?: boolean
}
/** 平台问「插件想要某项权限」 */
export type PermPrompt = { id: string; plugin: string; req: { pluginName: string; permission: string; scope?: string; reason?: string; title: string; description: string; risk: 'low' | 'medium' | 'high' } }
/** 插件用 platform.agent.ask 在手机上问的问题 */
export type PluginAsk = { id: string; plugin: string; pluginName: string; question: string; options: string[]; confirm: boolean; expires: number; test?: boolean }
