// 和服务端插件平台的连接（WS /api/platform/ws）：插件的能力调用、权限询问、插件在手机上问的问题都走这一条。
// 用到时才连；断了等下一次要发东西再连（或者还有没回来的调用时 1.5 秒后重连）。
// client id 每次打开页面生成一次：断线重连带同一个 id，服务端把断开期间的结果和询问补发过来，所以在途的调用不用重发。
import type { PermPrompt, PluginAsk } from './types'

const clientId = (() => { try { return crypto.randomUUID() } catch { return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` } })()

export const platformUi = $state({
  prompts: [] as PermPrompt[],
  asks: [] as PluginAsk[],
  connected: false,
})

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; s?: StreamCb }
/** 流式调用（AI）：chunk 收片段，tool 收「请插件页跑这个工具」；id 是这次调用在平台上的编号（cancel / tool-result 用） */
export type StreamCb = { chunk: (d: unknown) => void; tool: (rid: number, name: string, args: unknown) => void; id?: number }
const pending = new Map<number, Pending>()
let seq = 0
let ws: WebSocket | null = null
let outbox: string[] = []
let retry: ReturnType<typeof setTimeout> | null = null
let everOpen = false

// 插件数据在别处改了（Mac 上的 agent 经插件工具写的、别的设备）：服务端推 { t: 'db', plugin, docs }，转给打开着这个插件的页面。
// 连接断过再连上时通知页面拿一次全量（断开太久服务端那边的排队会被清掉）
type DbListener = { plugin: string; docs: (docs: unknown[]) => void; resync: () => void }
const dbListeners = new Set<DbListener>()
export function onPluginDb(l: DbListener) {
  dbListeners.add(l)
  connect()
  return () => { dbListeners.delete(l) }
}

export class PlatformError extends Error {
  code: string
  permission?: string
  constructor(e: { message?: string; code?: string; permission?: string }) {
    super(e.message || 'error')
    this.code = e.code || 'EERROR'
    this.permission = e.permission
  }
}

function connect() {
  if (ws && ws.readyState <= 1) return
  const url = new URL(`api/platform/ws?client=${clientId}`, location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const s = new WebSocket(url)
  ws = s
  s.onopen = () => {
    platformUi.connected = true
    if (everOpen) for (const l of dbListeners) l.resync()
    everOpen = true
    s.send(JSON.stringify({ t: 'vis', visible: document.visibilityState === 'visible' }))
    for (const m of outbox.splice(0)) s.send(m)
  }
  s.onmessage = (ev) => {
    let m: any
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (m.t === 'chunk' || m.t === 'tool') {
      const st = pending.get(m.id)?.s
      if (m.t === 'chunk') st?.chunk(m.data)
      else st?.tool(m.rid, m.name, m.args)
    } else if (m.t === 'result') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.value)
      else p.reject(new PlatformError(m.error || {}))
    } else if (m.t === 'prompt') {
      if (!platformUi.prompts.some((x) => x.id === m.id)) platformUi.prompts.push({ id: m.id, plugin: m.plugin, req: m.req })
    } else if (m.t === 'prompt-cancel') {
      platformUi.prompts = platformUi.prompts.filter((x) => x.id !== m.id)
    } else if (m.t === 'asks') {
      platformUi.asks = Array.isArray(m.list) ? m.list : []
    } else if (m.t === 'db' && Array.isArray(m.docs)) {
      for (const l of dbListeners) if (l.plugin === m.plugin) l.docs(m.docs)
    }
  }
  s.onclose = () => {
    if (ws === s) ws = null
    platformUi.connected = false
    // 有在途的调用、权限询问，或者有打开着的插件页（要收数据更新）：1.5 秒后重连
    if ((pending.size || platformUi.prompts.length || dbListeners.size) && !retry) retry = setTimeout(() => { retry = null; connect() }, 1500)
  }
}

export function send(msg: unknown) {
  const s = JSON.stringify(msg)
  if (ws?.readyState === 1) ws.send(s)
  else { outbox.push(s); if (outbox.length > 200) outbox.shift(); connect() }
}

/** 插件的一次能力调用（pluginId 由前端按消息来自哪个 iframe 决定，插件自己说了不算） */
export function platformCall<T = unknown>(plugin: string, method: string, args: unknown, s?: StreamCb): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    // 在手机上问的问题最多等 30 分钟；AI 最长 10 分钟加权限询问；其他调用可能要等权限询问（服务端那边 5 分钟超时），6 分钟没回来就算失败
    const ms = method === 'platform.agent.ask' ? 31 * 60000 : s ? 16 * 60000 : 6 * 60000
    const timer = setTimeout(() => { pending.delete(id); reject(new PlatformError({ message: '平台没有回应', code: 'ETIMEOUT' })) }, ms)
    if (s) s.id = id
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, s })
    send({ t: 'call', id, plugin, method, args, ...(s ? { stream: true } : {}) })
  })
}

/** 回答权限询问：once / always / block / dismiss（以后再说，连续 3 次转为禁止） */
export function answerPrompt(id: string, answer: 'once' | 'always' | 'block' | 'dismiss') {
  platformUi.prompts = platformUi.prompts.filter((x) => x.id !== id)
  send({ t: 'prompt-answer', id, answer })
}

export function answerPluginAsk(id: string, answer: string, text = '') {
  platformUi.asks = platformUi.asks.filter((x) => x.id !== id)
  send({ t: 'ask-answer', id, answer, text })
}

/** 插件这次打开结束（关闭）：「仅本次」的授权作废 */
export const endSession = (plugin: string) => { if (ws?.readyState === 1) send({ t: 'session-end', plugin }) }

/** 连上（打开抽屉时预热；也让手机能收到插件之前问的问题） */
export const warmup = () => connect()

document.addEventListener('visibilitychange', () => {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'vis', visible: document.visibilityState === 'visible' }))
  else if (document.visibilityState === 'visible' && (pending.size || platformUi.prompts.length || dbListeners.size)) connect()
})
