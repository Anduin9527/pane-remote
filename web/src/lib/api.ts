// 和 server.mjs 的接口一一对应
export type Pane = {
  pane: number
  tab: number
  window: number
  workspace: string
  title: string
  tabTitle: string
  cwd: string
  dir: string
  cols: number
  rows: number
  active: boolean
}

async function parse(r: Response) {
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

export async function postJson<T = any>(url: string, body?: unknown): Promise<T> {
  return parse(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }))
}

export async function fetchPanes(): Promise<Pane[]> {
  return parse(await fetch('api/panes', { cache: 'no-store' }))
}

export type ManageAction = 'spawn' | 'split' | 'kill' | 'title' | 'focus' | 'claude'
export const manage = <T = any>(action: ManageAction, body: unknown) => postJson<T>(`api/pane/${action}`, body)

export type CreateTarget = { window?: number; dir?: string; split?: Pane; direction?: 'right' | 'bottom' }

export const label = (p: Pane) => p.title || p.tabTitle || `pane ${p.pane}`

export function report(kind: string, msg: unknown) {
  try { navigator.sendBeacon('api/log', JSON.stringify({ kind, msg: String(msg).slice(0, 3000), t: Date.now() })) } catch {}
}

// ---------- 发送队列 ----------
// 一次只发一个请求；在途期间新按的键攒起来，下一次合并发出（快速滑动、长按方向键不会排长队）
// 文字和它后面的回车必须分两次发：合成一次的话 Claude Code 会当成粘贴，回车变换行
type Item = { pane: string; data: string; merge: boolean }
const outbox: Item[] = []
let sending = false
let onError: (msg: string) => void = () => {}
export function onSendError(fn: (msg: string) => void) { onError = fn }

// 每个请求最多等 12 秒（服务端调 bridge 自己有 10 秒超时）。iOS 主屏应用切后台、换网络后，
// 在途的请求有时既不成功也不失败，一直挂着；不设超时的话后面所有按键都卡在它后面，界面却照常刷新
const SEND_TIMEOUT = 12000
let sendingSince = 0
let inflight: AbortController | null = null
const dropped = new WeakSet<AbortController>() // 手动重连主动放弃的请求：不报「发送超时」

async function pump() {
  if (sending || !outbox.length) return
  sending = true
  sendingSince = Date.now()
  const { pane, data } = outbox.shift()!
  const ctl = new AbortController()
  inflight = ctl
  const timer = setTimeout(() => ctl.abort(), SEND_TIMEOUT)
  try {
    const r = await fetch('api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane: Number(pane), data }),
      signal: ctl.signal,
    })
    if (!r.ok) onError((await r.json().catch(() => ({}))).error || `发送失败 ${r.status}`)
  } catch (e) {
    if (dropped.has(ctl)) return
    onError(ctl.signal.aborted ? '发送超时，这一下可能没发出去，看一眼再决定要不要重发' : (e as Error).message)
    report('send-fail', `${ctl.signal.aborted ? 'timeout' : (e as Error).message} len=${data.length}`)
  } finally {
    clearTimeout(timer)
    if (inflight === ctl) { inflight = null; sending = false }
    pump()
  }
}
// 回到前台时，挂起期间计时器可能没跑：发现卡住的请求直接放弃，接着发后面的
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sending && Date.now() - sendingSince > SEND_TIMEOUT) inflight?.abort()
})

/** 手动重连时清空发送队列：放弃卡住的请求和还没发出去的输入（卡了很久的按键突然一起发出去反而危险），返回丢掉了几个 */
export function resetSendQueue() {
  const n = outbox.length + (sending ? 1 : 0)
  outbox.length = 0
  if (inflight) { dropped.add(inflight); inflight.abort() }
  return n
}

export function sendRaw(pane: string | null, data: string, merge = true) {
  if (!pane) return
  const last = outbox[outbox.length - 1]
  if (merge && last && last.merge && last.pane === pane) last.data += data
  else outbox.push({ pane, data, merge })
  pump()
}
