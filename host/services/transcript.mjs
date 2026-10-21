// transcript 主题（transcript:<pane>:<条数>）：fs.watch 盯着 pane 里 agent 的会话记录，文件一变就重新整理最近 N 条消息，
// 和上一次比，只推变了的部分：{drop, keep, tail}（见 ../delta.mjs）；对不上（换了会话之类）推 {full: [...]}。
// 消息格式和服务端 /api/transcript 返回的完全一样（都是 agent/pane-transcript 整理的）。
// 会话可能换（/clear、重启 agent）：每 10 秒重新找一次这个 pane 的会话；文件变化之外再加 2 秒一次 stat 兜底
import fs from 'node:fs'
import { Feed } from '../protocol.mjs'
import { diff, key } from '../delta.mjs'

export class TranscriptFeed extends Feed {
  constructor(host, pane, n) {
    super({ ring: 50, snapshot: () => ({ full: this.messages }) })
    this.host = host
    this.pane = pane
    this.n = n
    this.messages = []
    this.keys = []
    this.session = null
    this.watchers = new Map() // 文件 → fs.watch
    this.stamp = ''
    this.running = null
    this.dirty = false
    this.closed = false
    this.timer = null
  }
  async start() {
    await this.resolve()
    await this.refresh()
    this.poll = setInterval(() => { this.ensureWatch(); if (this.stampNow() !== this.stamp) this.kick() }, 2000)
    this.resolver = setInterval(() => this.resolve().then((changed) => changed && this.kick(), () => {}), 10000)
  }
  close() {
    this.closed = true
    clearInterval(this.poll)
    clearInterval(this.resolver)
    clearTimeout(this.timer)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
  /** 找这个 pane 的会话；记录文件换了就重新盯，返回是否换了 */
  async resolve() {
    const s = await this.host.agents.session(this.pane).catch(() => ({}))
    if (this.closed || (s.transcript || '') === (this.session?.transcript || '')) { this.session = s; return false }
    this.session = s
    for (const w of this.watchers.values()) w.close()
    this.watchers = new Map()
    this.ensureWatch()
    return true
  }
  /** 盯住会话的每个文件；还不存在的（新会话发第一条消息前、-wal）下次 stat 时再试，被替换掉的（rename）重新盯 */
  ensureWatch() {
    for (const f of this.host.agents.watchFiles(this.session)) {
      if (this.watchers.has(f)) continue
      try {
        const w = fs.watch(f, (type) => {
          if (type === 'rename') { w.close(); this.watchers.delete(f) }
          this.kick()
        })
        w.on('error', () => { w.close(); this.watchers.delete(f) })
        this.watchers.set(f, w)
      } catch {} // ignore: 文件还不存在，下次 stat 时再试
    }
  }
  stampNow() {
    return this.host.agents.watchFiles(this.session).map((f) => { try { const s = fs.statSync(f); return `${s.size}.${s.mtimeMs}` } catch { return '-' } }).join('/')
  }
  /** 文件变了：稍等合并一串写入，同一时间只跑一次整理，跑的时候又变了就跑完再来一次 */
  kick() {
    if (this.closed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), 60)
  }
  async refresh() {
    if (this.running) { this.dirty = true; return this.running }
    this.running = (async () => {
      do {
        this.dirty = false
        this.stamp = this.stampNow()
        let next
        try { next = await this.host.agents.messages(this.session, this.n) } catch { continue }
        if (this.closed) return
        const keys = next.map(key)
        if (keys.length === this.keys.length && keys.every((k, i) => k === this.keys[i])) continue
        const d = diff(this.messages, next, this.keys, keys)
        this.messages = next
        this.keys = keys
        this.publish(d || { full: next })
      } while (this.dirty && !this.closed)
    })()
    try { await this.running } finally { this.running = null }
  }
}
