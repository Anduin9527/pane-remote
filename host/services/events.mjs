// events 主题：tail hook 事件日志（agent/pane-event 写的 events.jsonl），有新行就推，替代服务端每 3 秒 `bridge events <偏移>` 的轮询。
// 序号 = 这一行结尾的「逻辑偏移」，和 bridge events 的偏移是同一个东西：pane-event 截断文件时把截掉的字节数写在第一行
// {"base":N}，逻辑偏移 = base + 行头之后的位置，只增不减。所以服务端存下的偏移两条路都能接着用，pane-host 重启也不影响补发。
// 文件会被整个替换（os.replace），所以看的是目录不是文件；再加 2 秒一次的 stat 兜底（fs.watch 偶尔漏）
import fs from 'node:fs'
import path from 'node:path'

const HEAD_RE = /^\{"base": ?(\d+)\}$/

export class EventsFeed {
  constructor(file) {
    this.file = file
    this.listeners = new Set()
    this.seq = this.layout().end // 只推以后的
    this.watcher = null
    this.poll = null
  }
  /** 文件现在的样子：base、行头长度、大小、最后一个完整行结尾的逻辑偏移 */
  layout() {
    let buf
    try { buf = fs.readFileSync(this.file) } catch { return { buf: Buffer.alloc(0), base: 0, hlen: 0, size: 0, end: 0 } }
    let base = 0, hlen = 0
    const nl = buf.indexOf(10)
    if (nl >= 0) {
      const m = HEAD_RE.exec(buf.subarray(0, nl).toString())
      if (m) { base = Number(m[1]); hlen = nl + 1 }
    }
    const last = buf.lastIndexOf(10)
    const complete = last < hlen ? hlen : last + 1
    return { buf, base, hlen, size: buf.length, end: base + complete - hlen }
  }
  /** 从逻辑偏移 from 读到 to（都是完整行的边界），交给 emit；from 比截掉的还旧 / 比文件还新时先发 reset */
  read(L, from, to, emit, replay) {
    let p = from - L.base + L.hlen
    if (p < L.hlen) { emit({ event: 'reset', seq: L.base, data: null }); p = L.hlen } // 太旧：中间截掉的补不了，读剩下的全部
    else if (from > L.end) { emit({ event: 'reset', seq: L.end, data: null }); return } // 文件被删了重建：只报位置，不重放
    const stop = to - L.base + L.hlen
    let off = L.base + p - L.hlen
    for (const line of L.buf.subarray(p, stop).toString().split('\n').slice(0, -1)) {
      off += Buffer.byteLength(line) + 1
      let data
      try { data = JSON.parse(line) } catch { continue }
      emit(replay ? { event: 'data', seq: off, data, replay: true } : { event: 'data', seq: off, data })
    }
  }
  check() {
    const L = this.layout()
    if (L.end === this.seq) return
    const from = this.seq
    this.seq = L.end
    this.read(L, from, L.end, (e) => { for (const l of this.listeners) l(e) }, false)
  }
  /** 全同步：先把文件读到最新，再补发 since 之后的，最后挂上，中间不会漏也不会重 */
  attach(listener, since) {
    this.start()
    this.check()
    if (since != null && since !== this.seq) this.read(this.layout(), since, this.seq, listener, true)
    this.listeners.add(listener)
    return this.seq
  }
  detach(listener) {
    this.listeners.delete(listener)
    if (!this.listeners.size) this.stop()
  }
  start() {
    if (this.poll) return
    const dir = path.dirname(this.file), name = path.basename(this.file)
    fs.mkdirSync(dir, { recursive: true })
    let timer = null
    try {
      this.watcher = fs.watch(dir, (_, f) => {
        if (f && f !== name) return
        clearTimeout(timer)
        timer = setTimeout(() => this.check(), 15) // pane-event 一次写完一行，稍等一下合并
      })
      this.watcher.on('error', () => {})
    } catch {} // ignore: 看不了目录就只靠 2 秒一次的 stat
    this.poll = setInterval(() => this.check(), 2000)
  }
  stop() {
    this.watcher?.close()
    this.watcher = null
    clearInterval(this.poll)
    this.poll = null
  }
}
