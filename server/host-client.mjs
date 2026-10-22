// 服务端到 Mac 上 pane-host 的长连接（ssh … `host`，协议见 host/protocol.mjs）。
// 断了自动重连（1 秒起指数退避，最长 30 秒），重连后按每个主题最后的序号重新订阅，pane-host 能补的补、补不了给 reset。
// 不在线时 call / stream 直接失败（调用方据此降级到老的 bridge 路径），订阅照样记着，连上后自动恢复。
//   const host = new HostClient({ spawn: () => spawn('ssh', [...SSH_ARGS, 'host']) }); host.start()
//   await host.call('ping')
//   const s = host.stream('terminals.watch', { pane }, (chunk) => …); s.cancel(); await s.done
//   流里带 rid 的片段是 pane-host 在要结果（AI 的工具调用）：s.reply(rid, { ok: true, value }) / s.reply(rid, { ok: false, error: { message, code } })
//   const sub = host.subscribe('events', { since, onEvent: (e) => …, onStatus: (up) => … }); sub.close()
import { EventEmitter } from 'node:events'
import { lineReader, encode, ERR } from '../host/protocol.mjs'

export class HostClient extends EventEmitter {
  // backoffFor(最后的错误)：返回毫秒就用它代替指数退避（比如对面根本不认 host 指令，没必要 30 秒试一次）
  constructor({ spawn, log = console.log, pingMs = 20000, pingTimeout = 8000, maxBackoff = 30000, backoffFor = () => null }) {
    super()
    this.backoffFor = backoffFor
    this.spawnProc = spawn
    this.log = log
    this.pingMs = pingMs
    this.pingTimeout = pingTimeout
    this.maxBackoff = maxBackoff
    this.proc = null
    this.connected = false
    this.nextId = 1
    this.pending = new Map() // id → { resolve, reject, onChunk, timer }
    this.subs = new Map() // topic → { since, onEvent, onStatus, live }
    this.backoff = 1000
    this.stopped = true
    this.lastError = ''
    this.upSince = 0
  }
  start() {
    if (!this.stopped) return
    this.stopped = false
    this.launch()
  }
  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.proc?.kill()
  }
  launch() {
    if (this.stopped || this.proc) return
    const proc = this.spawnProc()
    this.proc = proc
    let err = ''
    proc.stderr?.on('data', (d) => { err = (err + d).slice(-2000) })
    proc.stdin.on('error', () => {})
    lineReader(proc.stdout, (m) => this.onMessage(m))
    proc.on('error', (e) => { err += e.message })
    proc.on('close', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      clearInterval(this.pingTimer)
      const was = this.connected
      this.connected = false
      this.lastError = err.trim().split('\n').pop() || `exit ${code}`
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(`pane-host 断开：${this.lastError}`), { code: ERR.DOWN })); this.pending.delete(id) }
      for (const s of this.subs.values()) { s.live = false }
      if (was) { this.log(`host: down (${this.lastError})`); this.emit('down'); for (const s of this.subs.values()) s.onStatus?.(false) }
      if (this.stopped) return
      // 连上过一阵（30 秒以上）才算稳定，退避从头算；一连上就断的接着加倍
      if (was && Date.now() - this.upSince > 30000) this.backoff = 1000
      const wait = this.backoffFor(this.lastError) ?? this.backoff
      this.backoff = Math.min(this.maxBackoff, this.backoff * 2)
      this.retryTimer = setTimeout(() => this.launch(), wait)
    })
    // 第一次 ping 通了才算连上（ssh 本身连上不代表 pane-host 起来了）
    this.request(proc, 'ping', {}, { timeout: 15000 }).then((r) => {
      if (this.proc !== proc) return
      this.connected = true
      this.upSince = Date.now()
      this.log(`host: up (pane-host pid ${r.pid}, up ${r.uptime}s)`)
      this.emit('up', r)
      for (const [topic, s] of this.subs) this.resubscribe(topic, s)
      this.pingTimer = setInterval(() => {
        this.request(proc, 'ping', {}, { timeout: this.pingTimeout }).then((r) => this.emit('ping', r)).catch(() => { if (this.proc === proc) { this.log('host: ping timeout, reconnecting'); proc.kill() } })
      }, this.pingMs)
    }, () => { if (this.proc === proc) proc.kill() })
  }
  onMessage(m) {
    if (m.event) {
      const s = this.subs.get(m.topic)
      if (!s) return
      if (m.seq != null) s.since = m.seq
      try { s.onEvent(m) } catch (e) { this.log(`host: ${m.topic} handler: ${e.message}`) }
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    if ('chunk' in m) { try { p.onChunk?.(m.chunk) } catch (e) { this.log(`host: chunk handler: ${e.message}`) } return }
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    else p.resolve(m.result)
  }
  request(proc, method, params, { timeout = 10000, stream = false, onChunk } = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`pane-host ${method} 超时`)) }, timeout) : null
      this.pending.set(id, { resolve, reject, onChunk, timer, id })
      proc.stdin.write(encode({ jsonrpc: '2.0', id, method, params, ...(stream ? { stream: true } : {}) }))
    })
  }
  call(method, params = {}, { timeout = 10000 } = {}) {
    if (!this.connected) return Promise.reject(Object.assign(new Error('pane-host 不在线'), { code: ERR.DOWN }))
    return this.request(this.proc, method, params, { timeout })
  }
  /** 流式调用：每段交给 onChunk；cancel() 让服务端停下（done 以 CANCELLED 失败）；reply(rid, r) 回答流里的请求 */
  stream(method, params, onChunk) {
    if (!this.connected) return { done: Promise.reject(Object.assign(new Error('pane-host 不在线'), { code: ERR.DOWN })), cancel() {}, reply() {} }
    const proc = this.proc
    const id = this.nextId
    const done = this.request(proc, method, params, { timeout: 0, stream: true, onChunk })
    const notify = (m, p) => { if (this.proc === proc) proc.stdin.write(encode({ jsonrpc: '2.0', method: m, params: p })) }
    return { done, cancel: () => notify('cancel', { id }), reply: (rid, r) => notify('reply', { id, rid, ...r }) }
  }
  /**
   * 订阅主题。onEvent 收 {event: 'data'|'reset', seq, data, replay?}；onStatus(true/false) 在订阅生效 / 连接断开时调。
   * since：上次收到的序号（不带 = 只要以后的，0 = 从头）。重连时自动带最后一个序号
   */
  subscribe(topic, { since = null, onEvent, onStatus } = {}) {
    const s = { since, onEvent, onStatus, live: false }
    this.subs.set(topic, s)
    if (this.connected) this.resubscribe(topic, s)
    return {
      close: () => {
        if (this.subs.get(topic) !== s) return
        this.subs.delete(topic)
        if (this.connected) this.request(this.proc, 'unsub', { topic }).catch(() => {}) // ignore: 断线时退订失败无所谓，连接一断服务端就清掉了
      },
      get live() { return s.live },
    }
  }
  resubscribe(topic, s) {
    this.request(this.proc, 'sub', { topic, since: s.since }, { timeout: 30000 }).then((r) => {
      if (this.subs.get(topic) !== s) return
      s.since = r.seq
      s.live = true
      s.onStatus?.(true, r)
    }, (e) => {
      this.log(`host: sub ${topic} failed: ${e.message}`)
      // 主题本身不对（参数错）就别重试；其他（超时）等下次重连
      if (e.code === ERR.PARAMS && this.subs.get(topic) === s) { this.subs.delete(topic); s.onStatus?.(false, e) }
    })
  }
}
