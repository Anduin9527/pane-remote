// 插件实例和生命周期：
//   前台 fg   显示中，同一时间只有一个
//   后台 bg   隐藏但不卸载（iframe 设 inert、发 onLeave），后台超过 keepAlive（默认 5 分钟）就睡眠
//   睡眠 sleep 卸载页面，只留记录（进入时的数据、在列表里的位置），再打开就重新载入
//   关闭      记录也去掉，「仅本次」的权限作废
// App 隐藏超过 2 分钟：所有插件睡眠（回来时前台那个自动重新载入）。同时挂着页面的最多 3 个，超出按最近使用（LRU）让旧的睡眠。
// 对外：openPlugin(id, payload?) / closePlugin(id)（路由 #/plugin/<id> 调这两个）。
import { toast } from 'svelte-sonner'
import { t } from '$lib/i18n'
import type { EnterAction, Inst, PluginInfo } from './types'
import { defaultAction, match } from './match'
import { endSession, platformCall, PlatformError, send, type StreamCb } from './client.svelte'
import { getInnerView, innerViews, onInnerViewsChange } from './inner-view'

export const MAX_LOADED = 3
const num = (k: string, d: number) => { try { const v = Number(localStorage.getItem(k)); return v > 0 ? v : d } catch { return d } }
// 测试可以在 localStorage 里调短（plugins.keepAliveMs / plugins.hiddenMs）
const keepAliveMs = (p?: PluginInfo) => num('plugins.keepAliveMs', (p?.keepAlive || 300) * 1000)
const hiddenMs = () => num('plugins.hiddenMs', 2 * 60000)

export const plugins = $state({
  list: [] as PluginInfo[],
  loaded: false,
  error: '',
  instances: [] as Inst[],
  drawer: false,
  /** 等你确认退出的插件 id（手机上容易误触，退出要再点一次确认） */
  confirmClose: '',
})

/** 服务端的插件 + 前端自带的 inner-view */
function merged(remote: PluginInfo[]): PluginInfo[] {
  const inner: PluginInfo[] = innerViews().map((v) => ({
    id: v.id, name: v.name, version: '', description: v.description || '', logo: v.logo || '', main: '', container: 'inner-view', keepAlive: v.keepAlive || 300, format: 'inner-view', permissions: {},
    features: [{ code: v.id, description: v.description || '', cmds: (v.cmds?.length ? v.cmds : [v.name]).map((c) => (typeof c === 'string' ? { type: 'text', label: c } : { type: 'text', ...c })) }],
    icon: v.icon, header: v.header !== false, hidden: !!v.available && !v.available(),
  }))
  return [...inner, ...remote.filter((p) => !inner.some((x) => x.id === p.id))]
}
let remote: PluginInfo[] = []
onInnerViewsChange(() => (plugins.list = merged(remote)))

let loading: Promise<void> | null = null
export function loadPlugins(force = false): Promise<void> {
  if (loading && !force) return loading
  loading = (async () => {
    try {
      const r = await fetch('api/plugins', { cache: 'no-store' })
      if (!r.ok) throw new Error(r.status === 404 ? t('服务端没开插件平台') : `HTTP ${r.status}`)
      remote = (await r.json()).plugins || []
      plugins.list = merged(remote)
      plugins.error = ''
    } catch (e) {
      plugins.list = merged(remote)
      plugins.error = (e as Error).message
    } finally { plugins.loaded = true }
  })()
  return loading
}

export const info = (id: string) => plugins.list.find((p) => p.id === id)
/** 抽屉里列出来、参与匹配的（不含现在不能用的自带视图） */
export const visible = () => plugins.list.filter((p) => !p.hidden)
export const inst = (id: string) => plugins.instances.find((x) => x.id === id)
export const foreground = () => plugins.instances.find((x) => x.state === 'fg')
/** 悬浮按钮上的数字：后台和睡眠中的 */
export const backgroundCount = () => plugins.instances.filter((x) => x.state !== 'fg').length

function toBackground(x: Inst) {
  if (x.state !== 'fg') return
  x.state = 'bg'
  x.bgSince = Date.now()
}

/** 挂着页面的超过上限：最久没用的（不含前台）睡眠 */
function enforceLimit() {
  const live = plugins.instances.filter((x) => x.loaded).sort((a, b) => a.lastUsed - b.lastUsed)
  while (live.length > MAX_LOADED) {
    const victim = live.find((x) => x.state !== 'fg')
    if (!victim) break
    sleep(victim)
    live.splice(live.indexOf(victim), 1)
  }
}

function sleep(x: Inst) {
  x.loaded = false
  cancelStreams(x.id)
  if (x.state === 'bg') x.state = 'sleep'
}

/**
 * 打开插件（到前台）。payload：
 *   - 不传：第一个有功能指令的功能
 *   - EnterAction：原样进入（抽屉里命中的入口）
 *   - 字符串或别的值：按默认功能进入，payload 当输入数据（路由 #/plugin/<id> 带的数据）
 */
export async function openPlugin(id: string, payload?: unknown): Promise<boolean> {
  if (!info(id)) await loadPlugins(true)
  const p = info(id)
  if (!p) { toast.error(t('没有这个插件：{id}', { id })); return false }
  const action: EnterAction = isAction(payload) ? payload : payload === undefined ? defaultAction(p) : { ...defaultAction(p), payload, type: typeof payload === 'string' ? 'over' : 'text' }
  for (const x of plugins.instances) if (x.id !== id) toBackground(x)
  let x = inst(id)
  const now = Date.now()
  if (!x) {
    plugins.instances.push({ id, state: 'fg', loaded: true, gen: 1, enterSeq: 1, action, lastUsed: now, bgSince: 0 })
  } else {
    if (!x.loaded) { x.loaded = true; x.gen++; x.header = undefined }
    x.state = 'fg'
    x.action = action
    x.enterSeq++
    x.lastUsed = now
  }
  plugins.drawer = false
  enforceLimit()
  return true
}
const isAction = (v: unknown): v is EnterAction => !!v && typeof v === 'object' && typeof (v as EnterAction).code === 'string' && typeof (v as EnterAction).type === 'string'

/** 切到后台（隐藏不卸载） */
export function backgroundPlugin(id: string) {
  const x = inst(id)
  if (x) toBackground(x)
}

export function closePlugin(id: string) {
  const x = inst(id)
  if (!x) return
  plugins.instances = plugins.instances.filter((i) => i !== x)
  cancelStreams(id)
  if (info(id)?.container === 'iframe') endSession(id)
}

/** 退出插件前先问一句；真正退出走 closePlugin */
export function requestClose(id: string) {
  if (inst(id)) plugins.confirmClose = id
}

/** 重新载入：页面卸掉重来，在跑的流式调用一起取消 */
export function reloadPlugin(id: string) {
  const x = inst(id)
  if (!x?.loaded) return
  cancelStreams(id)
  x.gen++
  x.enterSeq++
  x.header = undefined
}

/** 立即睡眠（测试、内存紧张时用） */
export function sleepPlugin(id: string) {
  const x = inst(id)
  if (x?.loaded) { if (x.state === 'fg') x.state = 'bg'; sleep(x) }
}

// 后台超时检查；App 隐藏太久全部睡眠
setInterval(() => {
  const now = Date.now()
  for (const x of plugins.instances) if (x.loaded && x.state === 'bg' && now - x.bgSince > keepAliveMs(info(x.id))) sleep(x)
}, 5000)
let hiddenAt = 0
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
  if (!hiddenAt || Date.now() - hiddenAt < hiddenMs()) return
  hiddenAt = 0
  for (const x of plugins.instances) {
    if (!x.loaded) continue
    x.loaded = false
    cancelStreams(x.id)
    if (x.state === 'bg') x.state = 'sleep'
  }
  // 前台那个回来就重新载入
  const fg = foreground()
  if (fg) { fg.loaded = true; fg.gen++; fg.enterSeq++; fg.header = undefined }
})

// ---------- 插件页发来的消息 ----------
export type FrameMsg = { t: string; id?: number; method?: string; args?: any; stream?: boolean; rid?: number; ok?: boolean; value?: unknown; error?: unknown }
// 插件页里在跑的流式调用：`插件:插件页里的编号` → 平台上的编号（cancel、tool-result 要换成平台的编号转过去）
const liveStreams = new Map<string, StreamCb>()
/** 插件页卸载了（睡眠 / 关闭）：它在跑的流式调用一起取消，免得 电脑上的 agent 白跑 */
function cancelStreams(id: string) {
  for (const [k, s] of liveStreams) if (k.startsWith(id + ':') && s.id) { send({ t: 'cancel', id: s.id }); liveStreams.delete(k) }
}

/** 处理一条来自插件页的消息；reply 把结果发回插件页 */
export async function onFrameMessage(id: string, m: FrameMsg, reply: (msg: object) => void) {
  if (m.t === 'exit') return closePlugin(id)
  const key = `${id}:${m.id}`
  if (m.t === 'cancel' || m.t === 'tool-result') {
    const pid = liveStreams.get(key)?.id
    if (pid) send(m.t === 'cancel' ? { t: 'cancel', id: pid } : { t: 'tool-result', id: pid, rid: m.rid, ok: m.ok, value: m.value, error: m.error })
    return
  }
  if (m.t !== 'call' || typeof m.id !== 'number' || typeof m.method !== 'string') return
  const fid = m.id
  const s: StreamCb | undefined = m.stream ? { chunk: (data) => reply({ t: 'chunk', id: fid, data }), tool: (rid, name, args) => reply({ t: 'tool', id: fid, rid, name, args }) } : undefined
  if (s) liveStreams.set(key, s)
  try {
    let value = await platformCall<any>(id, m.method, m.args, s)
    if (value && typeof value === 'object' && typeof value.$delegate === 'string') value = await delegate(id, value.$delegate, m.args || {})
    reply({ t: 'result', id: m.id, ok: true, value })
  } catch (e) {
    const err = e instanceof PlatformError ? e : new PlatformError({ message: (e as Error).message })
    reply({ t: 'result', id: m.id, ok: false, error: { message: err.message, code: err.code, permission: err.permission } })
  } finally { if (s) liveStreams.delete(key) }
}

/** 服务端查过权限、交给前端做的能力 */
async function delegate(id: string, method: string, args: any): Promise<unknown> {
  const name = info(id)?.name || id
  if (method === 'system.notify') { toast(name, { description: String(args.body || '').slice(0, 300) }); return { shown: true } }
  if (method === 'clipboard.writeText') return copy(String(args.text ?? ''))
  if (method === 'shell.openExternal') {
    const url = String(args.url || '')
    if (!/^https?:\/\//i.test(url)) throw new PlatformError({ message: t('只能打开 http(s) 网址'), code: 'EBADARG' })
    window.open(url, '_blank', 'noopener')
    return true
  }
  if (method === 'launch.open') {
    // 目标：插件 id，或者某个插件的功能指令（像主输入框里输入一样匹配）
    const target = String(args.target ?? '')
    const p = info(target)
    if (p) return openPlugin(p.id, args.payload)
    const hit = match(plugins.list.filter((x) => x.id !== id), target).find((h) => h.type === 'text')
    if (!hit) throw new PlatformError({ message: t('找不到要打开的插件：{target}', { target }), code: 'ENOPLUGIN' })
    return openPlugin(hit.plugin.id, { code: hit.code, type: args.payload === undefined ? 'text' : 'over', payload: args.payload ?? hit.label, from: 'redirect' })
  }
  throw new PlatformError({ message: `unknown delegate ${method}`, code: 'EWTUNSUPPORTED' })
}

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  // 老办法：iOS 上 clipboard API 偶尔因为不在手势里被拒
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new PlatformError({ message: t('复制失败'), code: 'EERROR' })
  return true
}

export { getInnerView }
