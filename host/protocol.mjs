// pane-host 协议：按行 JSON（每行一条消息），JSON-RPC 2.0 加三种扩展。两端（Mac 上的 pane-host、服务端的 host-client）共用。
//   call    {jsonrpc, id, method, params}                → {jsonrpc, id, result} | {jsonrpc, id, error: {code, message}}
//   stream  {jsonrpc, id, method, params, stream: true}  → 若干条 {id, chunk}，最后 {id, result}（结束）或 {id, error}
//           取消：{jsonrpc, method: 'cancel', params: {id}}（通知，不回），服务端停掉后回 {id, error: {code: CANCELLED}}
//   sub     {jsonrpc, id, method: 'sub', params: {topic, since?}} → 先补发错过的事件，再回 {id, result: {topic, seq}}
//           之后服务端推 {event: 'data', topic, seq, data}；补不了的（序号太旧、服务端重启过）推一条
//           {event: 'reset', topic, seq, data}，data 是全量（事件流这种没有全量的，data 为 null，客户端从 seq 接着收）
//           since 不带 = 只要以后的；since: 0 = 从头要（transcript 会给一条 reset 全量）；补发的事件带 replay: true
//   unsub   {jsonrpc, id, method: 'unsub', params: {topic}} → {id, result: true}
// 序号只增不减：transcript 这类从启动时刻（毫秒）起算，pane-host 重启后也比旧的大，客户端带旧序号来只会拿到 reset
export const VERSION = 1
export const MAX_LINE = 16 << 20 // 单条消息上限（transcript 全量动辄几百 KB）
export const ERR = { PARSE: -32700, METHOD: -32601, PARAMS: -32602, INTERNAL: -32603, CANCELLED: -32800, DOWN: -32001 }

/** 把可读流按行切开，每行交给 onMessage（解析失败的行交给 onBad） */
export function lineReader(stream, onMessage, onBad = () => {}) {
  let buf = ''
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    if (buf.length > MAX_LINE && buf.indexOf('\n') < 0) { onBad(new Error('line too long')); buf = ''; return }
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch (e) { onBad(e, line); continue }
      onMessage(m)
    }
  })
}

export const encode = (m) => JSON.stringify(m) + '\n'

/**
 * 一个可订阅的主题：发布的每条数据带递增序号，留最近 ring 条用来给重连的客户端补发；
 * 补不了时用 snapshot() 给全量（reset）。订阅者是函数，收到 {event, seq, data, replay?}
 */
export class Feed {
  constructor({ ring = 200, snapshot = () => null } = {}) {
    this.seq = Date.now()
    this.ring = []
    this.max = ring
    this.snapshot = snapshot
    this.listeners = new Set()
  }
  publish(data) {
    this.seq++
    this.ring.push({ seq: this.seq, data })
    if (this.ring.length > this.max) this.ring.shift()
    for (const l of this.listeners) l({ event: 'data', seq: this.seq, data })
  }
  /** 状态整个换了（比如会话换了一个）：清掉补发缓存，所有订阅者收 reset */
  reset(data = this.snapshot()) {
    this.seq++
    this.ring = []
    for (const l of this.listeners) l({ event: 'reset', seq: this.seq, data })
  }
  /** 挂上一个订阅者：since 之后错过的补发（或给 reset），返回当前序号 */
  attach(listener, since) {
    if (since != null && since !== this.seq) {
      const first = this.ring[0]?.seq
      if (Number.isInteger(since) && since < this.seq && first != null && since >= first - 1) {
        for (const e of this.ring) if (e.seq > since) listener({ event: 'data', seq: e.seq, data: e.data, replay: true })
      } else listener({ event: 'reset', seq: this.seq, data: this.snapshot() })
    }
    this.listeners.add(listener)
    return this.seq
  }
  detach(listener) { this.listeners.delete(listener) }
}
