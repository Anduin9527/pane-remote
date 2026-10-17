// Cursor 映射的服务端：管电脑上的 cursor-agent（bridge cursor-ide 常驻），缓存状态，转发给手机。
//   GET  /api/cursor/stream?id=会话   SSE：status / sessions / messages / delta（手机在看哪个会话就让电脑那边盯哪个）
//   POST /api/cursor/cmd {t, ...}     launch / restart / open / send / stop / new / choose / refresh，等电脑那边的结果
// 只缓存：连接状态、会话列表、手机正在看的那个会话的最新消息快照（给后连上的手机）。不落盘。
import fs from 'node:fs'
import path from 'node:path'
let spawnBridge = null
let notify = () => {}
let proc = null
let buf = ''
let backoff = 2000
let restartTimer = null
let status = { conn: 'connecting', msg: '正在连接电脑…' }
let sessions = { projects: [], active: '' }
let snapshot = null // { id, list, ... } 当前在看的会话
// 未读 / 待办
let meta = {} // id → { updated, readAt, unread, status }（来自 Cursor 数据库）
let live = { active: '', choices: [], streaming: false } // Cursor 里当前打开的会话有没有可选按钮
let seenFile = ''
let seen = {} // id → 手机最后看过的时间
let firstSeen = {} // id → 服务端第一次见到这个会话的时间（之前的老会话不算未读）
let seenDirty = false
function loadSeen(dir) {
  seenFile = path.join(dir, 'cursor-seen.json')
  try { const d = JSON.parse(fs.readFileSync(seenFile, 'utf8')); seen = d.seen || {}; firstSeen = d.firstSeen || {} } catch {}
}
setInterval(() => {
  if (!seenDirty || !seenFile) return
  seenDirty = false
  // 只留最近 300 个会话，文件不会一直长
  const trim = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 300))
  seen = trim(seen); firstSeen = trim(firstSeen)
  fs.writeFile(seenFile, JSON.stringify({ seen, firstSeen }), { mode: 0o600 }, () => {})
}, 10000)
function markSeen(id) { if (id) { seen[id] = Date.now(); seenDirty = true } }
const WAIT_RE = /approv|review|input|waiting|permission|attention|action required|blocked/i
function decorate(s) {
  const m = meta[s.id]
  if (!firstSeen[s.id]) { firstSeen[s.id] = Date.now(); seenDirty = true }
  const read = Math.max(m?.readAt || 0, seen[s.id] || 0)
  const busy = /in progress|generat|running/i.test(s.status) || (live.active === s.id && live.streaming)
  // 未读：Cursor 自己标了未读、或者有比「电脑上看过 / 手机上看过」更新的内容；老会话以第一次见到为准
  const unread = !busy && !!m && ((m.unread && (seen[s.id] || 0) < m.updated) || m.updated > Math.max(read, firstSeen[s.id] || 0) + 1500)
  const waiting = WAIT_RE.test(s.status) || (live.active === s.id && live.choices.length > 0)
  return { ...s, unread: unread && !waiting, waiting, choices: live.active === s.id ? live.choices : [] }
}
function decorated() { return { projects: sessions.projects.map((p) => ({ ...p, sessions: p.sessions.map(decorate) })), active: sessions.active } }
let sessTimer = null
function pushSessions() { clearTimeout(sessTimer); sessTimer = setTimeout(() => broadcast('sessions', decorated()), 120) }
const clients = new Set() // { res, id }
const waiters = new Map() // req → { resolve, timer }
let reqSeq = 0

function send(m) { if (proc?.stdin.writable) proc.stdin.write(JSON.stringify(m) + '\n') }
function sse(res, event, data) { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch {} }
function broadcast(event, data, filter) { for (const c of clients) if (!filter || filter(c)) sse(c.res, event, data) }

// 最后一个连上 / 切换会话的手机说了算
function updateWatch() {
  const last = [...clients].at(-1)
  send({ t: 'watch', id: last?.id || '' })
}

function start() {
  if (proc) return
  const p = spawnBridge('cursor-ide')
  proc = p
  buf = ''
  let err = ''
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); const s = String(d); if (/mem rss|inject|db /.test(s)) console.log(s.trim()) })
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      backoff = 2000
      onAgent(m)
    }
  })
  p.on('close', (code) => {
    if (proc !== p) return
    proc = null
    for (const w of waiters.values()) { clearTimeout(w.timer); w.resolve({ ok: false, error: '和电脑的连接断了' }) }
    waiters.clear()
    status = { conn: 'error', msg: (err.trim().split('\n').pop() || `连接断了（${code}）`).replace(/^error: /, '') }
    broadcast('status', status)
    restartTimer = setTimeout(start, backoff)
    backoff = Math.min(60000, backoff * 2)
  })
  updateWatch()
}

function onAgent(m) {
  if (m.t === 'status') { status = { conn: m.conn, msg: m.msg, step: m.step }; broadcast('status', status) }
  else if (m.t === 'sessions') { sessions = { projects: m.projects, active: m.active }; pushSessions() }
  else if (m.t === 'meta') { meta = m.meta || {}; pushSessions() }
  else if (m.t === 'live') { live = { active: m.active, choices: m.choices || [], streaming: !!m.streaming }; pushSessions() }
  else if (m.t === 'messages') { snapshot = m; for (const c of clients) if (c.id === m.id) markSeen(m.id); broadcast('messages', m, (c) => c.id === m.id) }
  else if (m.t === 'delta') {
    if (snapshot?.id === m.id) {
      const byId = new Map(snapshot.list.map((x) => [x.id, x]))
      for (const u of m.upserts) byId.set(u.id, u)
      snapshot = { ...snapshot, ...m, list: m.order.map((k) => byId.get(k)).filter(Boolean), upserts: undefined, order: undefined }
    }
    if ([...clients].some((c) => c.id === m.id)) markSeen(m.id) // 手机正开着这个会话：新内容算看过了
    broadcast('delta', m, (c) => c.id === m.id)
  } else if (m.t === 'result') {
    const w = waiters.get(m.req)
    if (w) { clearTimeout(w.timer); waiters.delete(m.req); w.resolve(m) }
  } else if (m.t === 'changed') onChanged(m)
}

// 会话做完 / 在等你：推送（手机正在看这个会话就不推）
function onChanged(m) {
  const to = String(m.to || ''), from = String(m.from || '')
  const watched = [...clients].some((c) => c.id === m.id)
  if (watched) return
  if (/completed/i.test(to) && from && !/completed/i.test(from)) notify({ title: 'Cursor 做完了', body: m.title || '一个 Agent 会话', tag: `cursor-${m.id}`, cursor: m.id, kind: 'stop' })
  else if (/review|approv|input|waiting|action/i.test(to)) notify({ title: 'Cursor 在等你', body: `${m.title || ''}（${to}）`, tag: `cursor-${m.id}`, cursor: m.id, kind: 'wait' })
}

export function initCursor(opts) {
  spawnBridge = opts.spawnBridge
  if (opts.dataDir) loadSeen(opts.dataDir)
  notify = opts.notify || notify
  setTimeout(start, 3000)
}

export function cursorStream(req, res, url) {
  const id = (url.searchParams.get('id') || '').slice(0, 80)
  if (id && !/^[0-9a-f-]{8,64}$/i.test(id)) { res.writeHead(400); return res.end() }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  res.write('retry: 2000\n\n')
  const c = { res, id }
  clients.add(c)
  start()
  sse(res, 'status', status)
  markSeen(id)
  sse(res, 'sessions', decorated())
  if (id && snapshot?.id === id) sse(res, 'messages', snapshot)
  updateWatch()
  pushSessions()
  const ping = setInterval(() => { try { res.write('event: ping\ndata: {}\n\n') } catch {} }, 15000)
  res.on('close', () => { clearInterval(ping); clients.delete(c); markSeen(id); updateWatch() })
}

const CMDS = new Set(['launch', 'restart', 'open', 'send', 'stop', 'new', 'choose', 'refresh', 'changes', 'pin', 'archive', 'fork'])
export function cursorCmd(body) {
  if (!CMDS.has(body?.t)) return Promise.resolve({ ok: false, error: 'unknown command' })
  if (body.id && !/^[0-9a-f-]{8,64}$/i.test(String(body.id))) return Promise.resolve({ ok: false, error: 'bad id' })
  start()
  const req = ++reqSeq
  const m = { t: body.t, req }
  if (body.id) m.id = String(body.id)
  if (typeof body.text === 'string') m.text = body.text.slice(0, 20000)
  if (typeof body.project === 'string') m.project = body.project.slice(0, 500)
  if (typeof body.label === 'string') m.label = body.label.slice(0, 60)
  if (typeof body.on === 'boolean') m.on = body.on
  if (body.bubble) { if (!/^[0-9a-f-]{8,64}$/i.test(String(body.bubble))) return Promise.resolve({ ok: false, error: 'bad bubble' }); m.bubble = String(body.bubble) }
  return new Promise((resolve) => {
    // 启动 / 重启要等 Cursor 起来，最多 90 秒；其它 20 秒
    const timer = setTimeout(() => { waiters.delete(req); resolve({ ok: false, error: '电脑那边没有回应' }) }, /launch|restart|new|send|fork/.test(body.t) ? 90000 : 20000)
    waiters.set(req, { resolve, timer })
    send(m)
  })
}
export const cursorState = () => ({ status, sessions, viewers: clients.size })
/** 给待办收件箱和角标：在等你的会话（带可选按钮）、未读数 */
export function cursorSummary() {
  if (status.conn !== 'ready') return { conn: status.conn, waiting: [], unread: 0 }
  const all = decorated().projects.flatMap((p) => p.sessions.map((s) => ({ ...s, project: p.label })))
  const uniq = [...new Map(all.map((s) => [s.id, s])).values()]
  return { conn: status.conn, waiting: uniq.filter((s) => s.waiting).map(({ id, title, project, choices, status: st }) => ({ id, title, project, choices, status: st })), unread: uniq.filter((s) => s.unread).length }
}
