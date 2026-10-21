// 平台自带的插件（inner-view，同页 Shadow DOM）：预览、这台电脑、看屏幕，分别对应模块 preview、mac、screen（服务端没开的模块不出现在抽屉里）。
// 和别的插件一样从悬浮按钮的抽屉打开、地址 #/plugin/<id>，走插件层的生命周期：
//   前台 → 后台：组件不卸载、连接不断，组件收到 active = false 自己节流（预览压着 ack 不让电脑截下一张；看屏幕不再向转码代理要画面）
//   后台超过 keepAlive → 睡眠：卸载组件、断开连接；要恢复的状态（选的屏、缩放、模式、预览的网页……）组件自己存在 localStorage，重新打开时读回来
// 这里只有注册信息和图标（首屏），组件本身打开时才下载。
import { mount, unmount, type Component } from 'svelte'
import Globe from '@lucide/svelte/icons/globe'
import Gauge from '@lucide/svelte/icons/gauge'
import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone'
import { t } from '$lib/i18n'
import { appConfig, loadAppConfig } from '$lib/appConfig.svelte'
import { previewUi } from '$lib/preview/request.svelte'
import { adoptPageStyles, registerInnerView, refreshInnerViews, type InnerViewCtx } from './inner-view'

type Props = Record<string, unknown> & { active: boolean }

/**
 * 下载组件、挂进 shadow root。props 是响应式的：active 跟着前台 / 后台变；extra 给组件的其它 props，
 * setup 在挂载期间额外要做的事（返回清理函数）。返回卸载函数（睡眠、关闭时调）。
 */
function mountView(root: ShadowRoot, ctx: InnerViewCtx, load: () => Promise<{ default: Component<any> }>, extra: Record<string, unknown> = {}, setup?: () => (() => void) | void) {
  const props = $state<Props>({ active: true, ...extra })
  ctx.onEnter(() => (props.active = true))
  ctx.onLeave(() => (props.active = false))
  let app: Record<string, any> | null = null
  let dead = false
  const stop = setup?.()
  load().then((m) => {
    if (dead) return
    adoptPageStyles(root) // 组件分块带来的样式表这时才到
    app = mount(m.default, { target: root, props })
  }, (e) => {
    if (dead) return
    const p = document.createElement('p')
    p.className = 'p-6 text-center text-sm text-muted-foreground'
    p.textContent = t('插件载入失败：{msg}', { msg: (e as Error).message })
    root.append(p)
  })
  return () => { dead = true; stop?.(); if (app) unmount(app) }
}

const mod = (name: string) => () => !!appConfig.modules[name]

registerInnerView({
  id: 'preview',
  name: t('预览'),
  description: t('电脑上的浏览器'),
  icon: Globe,
  keepAlive: 600,
  cmds: [{ label: '预览', py: 'yulan', pyi: 'yl' }, { label: '浏览器', py: 'liulanqi', pyi: 'llq' }, 'preview', 'browser'],
  available: mod('preview'),
  // 全屏（横屏看电脑模式）时连插件顶栏一起藏起来
  mount: (root, ctx) => mountView(root, ctx, () => import('$lib/preview/PreviewView.svelte'), {}, () => $effect.root(() => { $effect(() => ctx.header(!previewUi.immersive)) })),
})

registerInnerView({
  id: 'mac',
  name: t('这台电脑'),
  description: t('性能、念一段话'),
  icon: Gauge,
  cmds: [{ label: '这台电脑', py: 'zhetaidiannao', pyi: 'ztdn' }, { label: '性能', py: 'xingneng', pyi: 'xn' }, { label: '念出来', py: 'nianchulai', pyi: 'ncl' }, 'mac', 'perf', 'say'],
  available: mod('mac'),
  mount: (root, ctx) => mountView(root, ctx, () => import('$lib/mac/MacPanel.svelte')),
})

registerInnerView({
  id: 'screen',
  name: t('看屏幕'),
  description: t('看电脑屏幕，远程操作'),
  icon: MonitorSmartphone,
  keepAlive: 1800,
  header: false, // 全屏，自己画顶栏
  cmds: [{ label: '看屏幕', py: 'kanpingmu', pyi: 'kpm' }, { label: '屏幕', py: 'pingmu', pyi: 'pm' }, { label: '屏幕共享', py: 'pingmugongxiang', pyi: 'pmgx' }, { label: '远程桌面', py: 'yuanchengzhuomian', pyi: 'yczm' }, 'vnc', 'screen', 'remote'],
  available: mod('screen'),
  // 左上角的按钮切到后台（连接不断）；「断开连接」/「锁屏并离开」才关掉插件
  mount: (root, ctx) => mountView(root, ctx, () => import('$lib/screen/ScreenView.svelte'), { open: true, onhide: () => ctx.background(), onclose: () => ctx.close() }),
})

// 服务端的模块开关读到了：哪些自带插件能用跟着变
loadAppConfig().then(refreshInnerViews)
