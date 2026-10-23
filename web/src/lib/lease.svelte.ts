// 单客户端在线（服务端见 lease.mjs）：同一时间只有一个客户端在用，新打开的顶掉旧的。
// 必须在 main.ts 第一个 import：要赶在任何模块发请求之前，把 fetch / EventSource / WebSocket 包上一层：
//   - 发往 api/ 的请求带上本客户端编号（fetch 加请求头，EventSource / WebSocket 加 _pc 参数）
//   - 收到被顶的信号（409 kicked、SSE 的 kicked 事件、WebSocket 关闭码 4001）就停掉所有连接，之后的请求直接失败不出网
//   - 连接无故断开时问一下服务端（api/lease）是不是被顶了
// 编号放 sessionStorage：同一个标签页刷新不变；被顶的标记也放这里，iOS 主屏幕 App 从后台回来自动重载时不会悄悄顶回去，
// 要点「在这台设备上继续」才接管。App 被杀掉重新打开（sessionStorage 清空）算重新访问，直接接管。
const ID_KEY = 'pr-client'
const KICK_KEY = 'pr-kicked'
const ss = {
  get: (k: string) => { try { return sessionStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v) } catch {} },
  del: (k: string) => { try { sessionStorage.removeItem(k) } catch {} },
}
function newId() {
  const a = new Uint8Array(12)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}
export const clientId: string = ss.get(ID_KEY) || newId()
ss.set(ID_KEY, clientId)

type Info = { device?: string; since?: number }
export const lease = $state({
  status: 'checking' as 'checking' | 'active' | 'kicked' | 'local',
  device: '', // 被顶时：现在在用的是哪台
  since: 0,
})

const FREE = /\/api\/(lease|claim|log)$/ // 被顶 / 本机时也放行：查状态、接管、上报问题
const origFetch = window.fetch.bind(window)
const OrigES = window.EventSource
const OrigWS = window.WebSocket
const live = new Set<{ close(): void }>()
let claimed = false
let markReady: () => void = () => {}
// 第一次接管有结果（成功 / 本机 / 失败）就放行：之前发的 api 请求先等着，免得被服务端当成旧客户端拒掉。最多等 5 秒（离线也能启动）
export const ready = new Promise<void>((r) => { markReady = r; setTimeout(r, 5000) })

function apiPath(u: string | URL): string | null {
  try {
    const url = new URL(String(u), location.href)
    return url.origin === location.origin && url.pathname.includes('/api/') ? url.pathname : null
  } catch { return null }
}
const blocked = (p: string) => (lease.status === 'kicked' || lease.status === 'local') && !FREE.test(p)

function kicked(i: Info) {
  if (!claimed) return void claim() // 还没接管成功（比如刚打开时网络不通）：别把自己当成被顶，再接管一次
  if (lease.status === 'kicked') return
  lease.status = 'kicked'
  lease.device = i.device || ''
  lease.since = i.since || Date.now()
  ss.set(KICK_KEY, JSON.stringify({ device: lease.device, since: lease.since }))
  for (const c of [...live]) { try { c.close() } catch {} }
  live.clear()
}
function local() {
  lease.status = 'local'
  for (const c of [...live]) { try { c.close() } catch {} }
  live.clear()
}

let checkTimer: ReturnType<typeof setTimeout> | undefined
function checkSoon() {
  if (lease.status !== 'active' || checkTimer) return
  checkTimer = setTimeout(async () => {
    checkTimer = undefined
    try {
      const { local: isLocal, active, ...info } = await (await origFetch('api/lease', { headers: { 'x-pane-client': clientId }, cache: 'no-store' })).json()
      if (isLocal) local()
      else if (!active) kicked(info)
    } catch {} // 网络不通：不是被顶，交给各自的重连
  }, 1000)
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const p = apiPath(input instanceof Request ? input.url : input)
  if (!p) return origFetch(input, init)
  if (!FREE.test(p)) await ready
  if (blocked(p)) throw new DOMException(lease.status === 'local' ? 'local host' : 'kicked', 'AbortError')
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set('x-pane-client', clientId)
  const res = await origFetch(input, { ...init, headers })
  if (res.status === 409 || res.status === 403) {
    const body = await res.clone().json().catch(() => null)
    if (body?.error === 'kicked') kicked(body)
    else if (body?.error === 'local-host') local()
  }
  return res
}

const withPc = (u: string | URL) => {
  if (!apiPath(u)) return u
  const url = new URL(String(u), location.href)
  url.searchParams.set('_pc', clientId)
  return url.href
}

class LeaseEventSource extends OrigES {
  constructor(url: string | URL, init?: EventSourceInit) {
    super(withPc(url), init)
    if (!apiPath(url)) return
    if (blocked('/api/')) { this.close(); return }
    live.add(this)
    this.addEventListener('kicked', (e) => { this.close(); kicked(JSON.parse((e as MessageEvent).data || '{}')) })
    this.addEventListener('error', () => { if (this.readyState === OrigES.CLOSED) live.delete(this); checkSoon() })
  }
  close() { live.delete(this); super.close() }
}
class LeaseWebSocket extends OrigWS {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(withPc(url), protocols)
    if (!apiPath(url)) return
    if (blocked('/api/')) { this.close(); return }
    live.add(this)
    this.addEventListener('close', (e) => {
      live.delete(this)
      if (e.code === 4001) { let i: Info = {}; try { i = JSON.parse(e.reason) } catch {} kicked(i) } else checkSoon()
    })
  }
}
window.EventSource = LeaseEventSource as typeof EventSource
window.WebSocket = LeaseWebSocket as unknown as typeof WebSocket

async function claim() {
  try {
    const res = await origFetch('api/claim', { method: 'POST', headers: { 'x-pane-client': clientId }, cache: 'no-store' })
    const body = await res.json().catch(() => null)
    if (body?.error === 'local-host') { local(); return markReady() }
    if (res.ok) { claimed = true; lease.status = 'active' }
  } catch {}
  if (!claimed) { lease.status = 'active'; setTimeout(claim, 3000) } // 网络不通：界面照常（显示离线），过会儿再接管
  markReady()
}

// 被顶后点「在这台设备上继续」：清掉标记重载，重载时重新接管（所有连接重新建立，最省心）
export function takeOver() {
  ss.del(KICK_KEY)
  location.reload()
}

const prev = (() => { try { return JSON.parse(ss.get(KICK_KEY) || 'null') as Info | null } catch { return null } })()
if (prev) {
  claimed = true
  lease.status = 'kicked'
  lease.device = prev.device || ''
  lease.since = prev.since || 0
  markReady()
} else claim()
