// 插件平台前端的对外接口（路由、外壳、以后的看屏幕迁移用）
export { openPlugin, closePlugin, backgroundPlugin, sleepPlugin, loadPlugins, plugins } from './plugins.svelte'
export { registerInnerView, type InnerView, type InnerViewCtx } from './inner-view'
export type { PluginInfo, EnterAction, Inst } from './types'
