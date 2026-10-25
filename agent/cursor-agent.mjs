// Cursor 映射：在电脑上接管 Cursor IDE（Electron）的页面，把会话 / 消息整理成我们自己的数据，手机端自己渲染。
// 不传画面，只传数据：会话列表、状态来自页面（注入一段只读观察脚本），完整消息来自 Cursor 自己的本地数据库（只读）。
// 由 bridge 的 cursor-ide 命令启动（pane-remote enable cursor 开启），stdin / stdout 每行一个 JSON。
//
// 收（服务端 → 这里）：
//   watch{id}            手机在看哪个会话（空 = 没人看消息，只保留会话列表监听）
//   launch / restart     启动 Cursor（没开时）/ 正常退出再带调试端口重开（开着但没调试端口时，要手机那头确认过）
//   open{id} send{id,text} stop new{project} choose{label} refresh
//   model{id}            会话用的模型和思考等级 + 可选模型（来自本地数据库）
//   model-set{id, model, effort}  切换会话的模型 / 思考等级：先打开会话，再操作输入框下方的选择器，最后从数据库读回确认（会话在生成时拒绝）
// 发（这里 → 服务端）：
//   status{conn, msg, step?}      conn: not-running | no-debug | launching | connecting | ready | error
//   sessions{projects, active}    项目 → 会话（id、标题、时间、状态），active = Cursor 里当前打开的
//   messages{id, list, status, choices}   某个会话的完整消息（打开时发一次）
//   delta{id, upserts, status, choices}   之后只发变了的消息
//   result{req, ok, error?}
//
// 资源：内存里最多 MAX_SESSIONS 个会话的消息，每个最多 MAX_MSGS 条、每条最长 MAX_TEXT；思考只记长度；不往硬盘写任何东西。
// 数据库有好几 GB：只读打开，只按主键点查和按前缀范围查（走索引），绝不全表扫。
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const PORT = Number(process.env.CURSOR_DEBUG_PORT || 9333)
const DB_PATH = path.join(os.homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
const MAX_SESSIONS = 30
const MAX_MSGS = 200
const MAX_TEXT = 20000
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const log = (...a) => process.stderr.write(`[cursor] ${a.join(' ')}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 数据库（只读） ----------
let db = null
function openDb() {
  if (db) return db
  try {
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(DB_PATH, { readOnly: true })
    db.exec('PRAGMA query_only = 1')
  } catch (e) { log('db', e.message); db = null }
  return db
}
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let qComposer = null, qBubble = null
function getJson(stmt, key) {
  try { const row = stmt.get(key); return row ? JSON.parse(row.value) : null } catch { return null }
}
function composer(id) {
  if (!openDb()) return null
  qComposer ||= db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
  return getJson(qComposer, `composerData:${id}`)
}
/** 一批会话的元数据：更新时间、Cursor 自己的已读时间和未读标记、状态。只取这几个字段（SQLite 在 C 里解析 JSON，不进 JS） */
function metaFor(ids) {
  if (!openDb() || !ids.length) return {}
  const out = {}
  try {
    const keys = ids.slice(0, 200).map((id) => `composerData:${id}`)
    const stmt = db.prepare(`SELECT key, json_extract(value,'$.lastUpdatedAt') AS u, json_extract(value,'$.lastReadAtMs') AS r, json_extract(value,'$.hasUnreadMessages') AS n, json_extract(value,'$.status') AS s FROM cursorDiskKV WHERE key IN (${keys.map(() => '?').join(',')})`)
    for (const row of stmt.all(...keys)) out[row.key.slice(13)] = { updated: Number(row.u) || 0, readAt: Number(row.r) || 0, unread: !!row.n, status: row.s || '' }
  } catch (e) { log('meta', e.message) }
  return out
}
// 消息列表，Cursor 换过三次存法，三种都还在用（老会话不迁移），所以都读，哪个最新用哪个：
//   1. composerData.fullConversationHeadersOnly（3.25 及以前的会话）
//   2. ~/.cursor/projects/<项目>/agent-transcripts/<id>/<id>.jsonl（3.26：上面那个是空的）
//   3. composerConvHeaders:<会话>:000000…，每块 256 条的 JSON 数组（3.27：1 是空的，2 不再追加，composerData 跑的过程中也不更新）
/** 一条消息头的时间：完成 / 开始 / 创建里最晚的（毫秒） */
const headerAt = (h) => Math.max(Number(h?.completedAtMs) || 0, Number(h?.startedAtMs) || 0, Date.parse(h?.createdAt || '') || 0)
let qHeaders = null
/** 数据库里的消息头（1 和 3 里更新的那份）。分块的只取最后两块（够 MAX_MSGS 条） */
function headersOf(id, c) {
  const inline = (c.fullConversationHeadersOnly || []).slice(-MAX_MSGS)
  let chunked = []
  if (openDb()) {
    try {
      qHeaders ||= db.prepare('SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key DESC LIMIT 2')
      chunked = qHeaders.all(`composerConvHeaders:${id}:`, `composerConvHeaders:${id};`).reverse().flatMap((r) => { try { return JSON.parse(r.value) } catch { return [] } }).slice(-MAX_MSGS)
    } catch (e) { log('headers', e.message) }
  }
  if (!chunked.length) return inline
  if (!inline.length) return chunked
  return headerAt(chunked.at(-1)) >= headerAt(inline.at(-1)) ? chunked : inline
}
// 记录文件比数据库新出这么多才换过去（或者反过来）：两边都在写时不来回跳。两边一样新时用数据库（有 Cursor 自己的消息 id，分叉要用）
const SOURCE_SLACK = 60000
function useTranscript(id, c, headers, e) {
  const file = transcriptPath(id)
  if (!file) return false
  if (!headers.length) return true
  let tAt = 0
  try { tAt = fs.statSync(file).mtimeMs } catch { return false }
  const dbAt = Math.max(headerAt(headers.at(-1)), Number(c.lastUpdatedAt) || 0)
  return e?.src === 't' ? !(dbAt > tAt + SOURCE_SLACK) : tAt > dbAt + SOURCE_SLACK
}
function bubble(cid, bid) {
  if (!openDb()) return null
  qBubble ||= db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
  return getJson(qBubble, `bubbleId:${cid}:${bid}`)
}

const clip = (s, n = MAX_TEXT) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…（太长，截掉了）' : s) : '')
const TOOL_NAMES = { run_terminal_command_v2: '执行命令', read_file_v2: '读文件', ripgrep_raw_search: '搜索', glob_file_search: '找文件', web_search: '网页搜索', edit_file_v2: '改文件', edit_file: '改文件', search_replace: '改文件', write: '写文件', delete_file: '删文件', list_dir: '列目录', get_mcp_tools: 'MCP 工具' }
function toolSummary(tf) {
  let p = {}
  try { p = typeof tf.params === 'string' ? JSON.parse(tf.params) : tf.params || {} } catch {}
  if (!Object.keys(p).length) { try { p = JSON.parse(tf.rawArgs || '{}') } catch {} }
  const pick = p.command || p.targetFile || p.target_file || p.path || p.relativeWorkspacePath || p.query || p.pattern || p.globPattern || p.searchTerm || ''
  return clip(String(pick).replace(/\s+/g, ' '), 200)
}
/** 一条 bubble → 手机端用的消息 */
function normalize(b, bid) {
  if (!b) return null
  const ts = b.createdAt ? Date.parse(b.createdAt) || b.createdAt : 0
  if (b.type === 1) return { id: bid, role: 'user', text: clip(b.text || ''), ts }
  if (b.toolFormerData) {
    const tf = b.toolFormerData
    const m = { id: bid, role: 'tool', tool: TOOL_NAMES[tf.name] || tf.name || '工具', detail: toolSummary(tf), status: tf.status || '', decision: tf.userDecision || '', ts }
    // 执行命令：带上输出（只留最后 3000 字，长输出看尾巴最有用）、目录、是否被拒绝
    if (/run_terminal_command/.test(tf.name || '')) {
      let r = {}, p = {}
      try { r = typeof tf.result === 'string' ? JSON.parse(tf.result) : tf.result || {} } catch {}
      try { p = typeof tf.params === 'string' ? JSON.parse(tf.params) : tf.params || {} } catch {}
      const o = typeof r.output === 'string' ? r.output : ''
      m.output = o.length > 3000 ? '…' + o.slice(-3000) : o
      m.cwd = clip(String(p.cwd || ''), 300)
      m.rejected = !!r.rejected
    }
    if (tf.status === 'error' && tf.error) m.error = clip(typeof tf.error === 'string' ? tf.error : JSON.stringify(tf.error), 500)
    return m
  }
  if (b.thinking) return { id: bid, role: 'thinking', size: (b.thinking.text || '').length, ts }
  if (b.text) return { id: bid, role: 'assistant', text: clip(b.text), ts }
  return null
}

// ---------- 会话记录文件（Cursor 3.26 起新会话的消息只在这里） ----------
// ~/.cursor/projects/<项目>/agent-transcripts/<会话 ID>/<会话 ID>.jsonl，只追加：每行一条消息
// {role, message:{content:[{type:'text',text} | {type:'tool_use',name,input}]}}，或者一轮结束 {type:'turn_ended', status, error?}。
// 用户消息包在 <timestamp>…</timestamp><user_query>…</user_query> 里。官方钩子给的 transcript_path 就是它。
// Cursor 3.26 起，新会话的 composerData 里消息列表是空的（旧会话两边都有），只读旧位置的话新会话就对不上
const TRANSCRIPTS = path.join(os.homedir(), '.cursor/projects')
const tpaths = new Map()
function transcriptPath(id) {
  const known = tpaths.get(id)
  if (known && fs.existsSync(known)) return known
  try {
    for (const p of fs.readdirSync(TRANSCRIPTS)) {
      const f = path.join(TRANSCRIPTS, p, 'agent-transcripts', id, `${id}.jsonl`)
      if (fs.existsSync(f)) { tpaths.set(id, f); return f }
    }
  } catch {}
  return ''
}
const TOOL_ALIASES = { Shell: '执行命令', Bash: '执行命令', Edit: '改文件', Read: '读文件', Grep: '搜索', Glob: '找文件', StrReplace: '改文件', Write: '写文件', Delete: '删文件', LS: '列目录', WebSearch: '网页搜索', WebFetch: '读网页', GetDynamicTools: 'MCP 工具', CallDynamicTool: 'MCP 工具', TodoWrite: '待办', Task: '子任务' }
function transcriptTool(name, input = {}) {
  const mcp = input.toolName ? `${input.namespace ? input.namespace + ' · ' : ''}${input.toolName}` : ''
  const pick = input.command || mcp || input.path || input.file_path || input.target_file || input.pattern || input.glob_pattern || input.query || input.url || input.description || input.branchName || input.name || ''
  return { tool: TOOL_ALIASES[name] || name || '工具', detail: clip(String(pick).replace(/\s+/g, ' '), 200) }
}
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
/** 「Wednesday, Oct 21, 2026, 9:47 PM (UTC+8)」→ 毫秒 */
function parseStamp(s) {
  const m = /([A-Z][a-z]{2}) (\d+), (\d{4}), (\d+):(\d+) (AM|PM) \(UTC([+-]\d+)(?::(\d+))?\)/.exec(s || '')
  if (!m) return 0
  const h = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0), off = Number(m[7]) * 60 + Math.sign(Number(m[7])) * Number(m[8] || 0)
  return Date.UTC(Number(m[3]), MONTHS[m[1]] ?? 0, Number(m[2]), h, Number(m[5])) - off * 60000
}
/** 一行记录 → 0..n 条手机端消息（id = t<行号>.<第几段>，文件只追加，行号不变） */
function transcriptLine(d, n) {
  if (d.type === 'turn_ended') return d.status === 'success' ? [] : [{ id: `t${n}`, role: 'assistant', text: d.status === 'aborted' ? '（这一轮被停止了）' : `（这一轮出错了${d.error ? '：' + clip(String(d.error), 300) : ''}）`, ts: 0 }]
  const parts = d.message?.content || []
  if (d.role === 'user') {
    const raw = parts.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n')
    const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw)
    return [{ id: `t${n}`, role: 'user', text: clip((q ? q[1] : raw.replace(/<(\w+)>[\s\S]*?<\/\1>/g, '')).trim()), ts: parseStamp(/<timestamp>([\s\S]*?)<\/timestamp>/.exec(raw)?.[1]) }]
  }
  if (d.role !== 'assistant') return []
  return parts.map((c, i) => c.type === 'text' ? (c.text ? { id: `t${n}.${i}`, role: 'assistant', text: clip(c.text), ts: 0 } : null)
    : c.type === 'tool_use' ? { id: `t${n}.${i}`, role: 'tool', ...transcriptTool(c.name, c.input), status: '', decision: '', ts: 0 }
    : c.type === 'thinking' ? { id: `t${n}.${i}`, role: 'thinking', size: (c.thinking || c.text || '').length, ts: 0 } : null).filter(Boolean)
}
/** 增量读记录文件：只读上次之后追加的部分；文件变小了（被重写）就从头读。e.t = { file, off, line, rest, ended } */
function readTranscript(id, e) {
  const file = transcriptPath(id)
  if (!file) return null
  let size = 0
  try { size = fs.statSync(file).size } catch { return null }
  if (!e.t || e.t.file !== file || size < e.t.off) { e.t = { file, off: 0, line: 0, rest: '', ended: '' }; e.order = []; e.byId = new Map() }
  const upserts = []
  if (size > e.t.off) {
    // 很长的会话第一次只读最后 4MB（够 MAX_MSGS 条），行号从那里开始数也没关系：id 只要在这个进程里稳定
    const start = e.t.off === 0 && size > 4 << 20 ? size - (4 << 20) : e.t.off
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    let text = e.t.rest + buf.toString('utf8')
    if (start !== e.t.off) text = text.slice(text.indexOf('\n') + 1) // 从中间开始读：丢掉不完整的第一行
    const lines = text.split('\n')
    e.t.rest = lines.pop() // 最后一行可能还没写完
    for (const l of lines) {
      const n = e.t.line++
      let d
      try { d = JSON.parse(l) } catch { continue }
      if (d.type === 'turn_ended') e.t.ended = d.status || ''
      else if (d.role === 'user') e.t.ended = ''
      for (const m of transcriptLine(d, n)) { e.byId.set(m.id, m); e.order.push(m.id); upserts.push(m) }
    }
    e.t.off = size
    if (e.order.length > MAX_MSGS) { for (const k of e.order.splice(0, e.order.length - MAX_MSGS)) e.byId.delete(k) }
  }
  return upserts
}

/** 改过几个文件（手机上「改动」按钮的数字，0 就不显示按钮）。3.26 起 originalFileStates 是空的：数 ofsContent:<会话>: 下的原文（含只读过的文件，会偏多一点） */
let qOfsCount = null
function changedCount(id, c) {
  const n = Object.keys(c.originalFileStates || {}).length
  if (n || !openDb()) return n
  try { qOfsCount ||= db.prepare('SELECT count(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?'); return Number(qOfsCount.get(`ofsContent:${id}:`, `ofsContent:${id};`).n) || 0 } catch { return 0 }
}

// ---------- loop（/loop）----------
// Cursor 本地的 /loop 是一个后台终端：sleep N 秒后输出 AGENT_LOOP_TICK_<用途>（或 AGENT_LOOP_WAKE_<用途>）把 agent 叫醒。
// 固定间隔是一个一直跑的 while 循环；动态间隔每次叫醒后 agent 再起一个新的。会话数据里不记这些，
// 但 Cursor 把每个后台终端写在 ~/.cursor/projects/<项目>/terminals/<编号>.txt：开头一段 key: value（pid、command、
// title「Loop every 3m: …」、status running/succeeded…、started_at、running_for_ms），后面是输出。
// 终端不记属于哪个会话：按会话记录里出现过的标记（用途名）对上
const LOOP_RE = /AGENT_LOOP_(?:TICK|WAKE)_([A-Za-z0-9_-]+)/
const loopMarks = new Map() // 会话 → { file, off, marks:Set }，增量扫会话记录
function loopMarksOf(id) {
  const file = transcriptPath(id)
  if (!file) return new Set()
  let e = loopMarks.get(id)
  if (!e || e.file !== file) { e = { file, off: 0, marks: new Set() }; loopMarks.set(id, e) }
  try {
    const size = fs.statSync(file).size
    if (size < e.off) { e.off = 0; e.marks.clear() }
    if (size > e.off) {
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(size - e.off)
      fs.readSync(fd, buf, 0, buf.length, e.off); fs.closeSync(fd)
      for (const m of buf.toString('utf8').matchAll(new RegExp(LOOP_RE, 'g'))) e.marks.add(m[1])
      e.off = Math.max(e.off, size - 200) // 留一点重叠：标记刚好被切在两次读之间
    }
  } catch {}
  return e.marks
}
function terminalHeader(file) {
  let head = ''
  try { const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); head = buf.subarray(0, n).toString('utf8') } catch { return null }
  const m = /^---\n([\s\S]*?)\n---/.exec(head)
  if (!m) return null
  const h = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ')
    if (i < 0) continue
    const k = line.slice(0, i), v = line.slice(i + 2).trim()
    try { h[k] = v.startsWith('"') ? JSON.parse(v) : /^\d+$/.test(v) ? Number(v) : v } catch { h[k] = v }
  }
  return h
}
const alive = (pid) => { try { return pid > 0 && process.kill(pid, 0) } catch { return false } }
/** 这个会话的 loop：每个用途一条，取最新的那个终端判断状态 */
function loopsOf(id) {
  const marks = loopMarksOf(id)
  if (!marks.size) return []
  const dir = path.join(path.dirname(path.dirname(path.dirname(transcriptPath(id)))), 'terminals')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => { const p = path.join(dir, f); return { p, t: fs.statSync(p).mtimeMs } }) } catch { return [] }
  files = files.filter((f) => Date.now() - f.t < 3 * 86400e3).sort((a, b) => b.t - a.t).slice(0, 80)
  const by = new Map()
  for (const f of files) {
    const h = terminalHeader(f.p)
    const m = h && LOOP_RE.exec(String(h.command || ''))
    if (!m || !marks.has(m[1])) continue
    const started = Date.parse(h.started_at) || 0
    const x = by.get(m[1]) || { purpose: m[1], ticks: 0, lastTickAt: 0, latest: null }
    if (h.status === 'succeeded' || h.status === 'completed') { x.ticks++; x.lastTickAt = Math.max(x.lastTickAt, started + (Number(h.running_for_ms) || 0)) }
    if (!x.latest || started > x.latest.started) x.latest = { ...h, started }
    by.set(m[1], x)
  }
  return [...by.values()].map(({ purpose, ticks, lastTickAt, latest: h }) => {
    const cmd = String(h.command || '')
    const sleep = Number(/sleep\s+(\d+)/.exec(cmd)?.[1]) || 0
    const fixed = /while\s+true/.test(cmd)
    let prompt = ''
    try { prompt = JSON.parse(/AGENT_LOOP_\w+_[A-Za-z0-9_-]+\s+(\{.*\})/.exec(cmd)?.[1].replace(/\\"/g, '"') || '{}').prompt || '' } catch {}
    const running = h.status === 'running' && alive(Number(h.pid))
    // 动态间隔：在跑 = 正在等下一次（下次 = 开始 + sleep）；最新那个已经跑完、没再起新的 = 停了（或 agent 正在处理这次）
    const state = running ? 'waiting' : 'stopped'
    const nextAt = running && sleep ? (fixed ? h.started + Math.ceil((Date.now() - h.started) / (sleep * 1000)) * sleep * 1000 : h.started + sleep * 1000) : 0
    return { purpose, title: String(h.title || ''), prompt: clip(prompt, 500), fixed, interval: sleep, state, nextAt, startedAt: h.started, lastTickAt, ticks }
  }).sort((a, b) => (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) || b.startedAt - a.startedAt).slice(0, 5)
}

// 会话消息缓存：id → { updated, order:[bid], byId: Map(bid → msg), status, generating:Set }，按最近使用淘汰
const cache = new Map()
function touch(id, entry) { cache.delete(id); cache.set(id, entry); while (cache.size > MAX_SESSIONS) cache.delete(cache.keys().next().value) }

/** 读一个会话：第一次读最近 MAX_MSGS 条；之后只读新出现的和正在生成的消息。返回变化 */
function readSession(id) {
  const c = composer(id)
  if (!c) return null
  const headers = headersOf(id, c)
  const generating = new Set(c.generatingBubbleIds || [])
  let e = cache.get(id)
  const src = useTranscript(id, c, headers, e) ? 't' : 'db'
  // 换了来源（比如 Cursor 升级后记录文件不再更新）：消息 id 两边不一样，整份重读重发
  if (e && e.src !== src) e = null
  const fresh = !e
  if (!e) e = { src, updated: 0, order: [], byId: new Map(), status: '', generating: new Set() }
  if (src === 't') {
    const ups = readTranscript(id, e)
    if (ups) {
      const status = e.t.ended ? (e.t.ended === 'success' ? 'completed' : e.t.ended) : (c.status || '')
      const statusChanged = status !== e.status
      e.updated = c.lastUpdatedAt; e.status = status; e.generating = generating
      touch(id, e)
      e.path = c.workspaceIdentifier?.uri?.fsPath || ''
      e.changed = changedCount(id, c)
      return { fresh, upserts: ups, statusChanged, entry: e, name: c.name || '' }
    }
  }
  const upserts = []
  // 会话还没结束（或页面上正在生成）时，最后几条每次都重读：Cursor 先写一条空消息，生成完再把内容填进去
  // 3.27 跑的过程中不再更新 composerData（status 可能还停在上一轮的 aborted、generatingBubbleIds 是空的）：侧边栏状态更准
  const busy = generating.size > 0 || e.generating.size > 0 || !/^(completed|aborted|error)$/i.test(c.status || '') || (watching === id && !!lastLive?.streaming) || sidebarBusy(id)
  const tail = new Set(busy ? headers.slice(-3).map((h) => h.bubbleId) : [])
  const lastKey = headers.at(-1)?.bubbleId || ''
  // 状态已经是「完成」时，回复内容可能还没写进数据库：最后 5 条里有空的就继续读，直到有内容
  const recent = new Set(headers.slice(-5).map((h) => h.bubbleId))
  const waitingFill = headers.slice(-5).some((h) => !e.byId.get(h.bubbleId))
  if (fresh || busy || waitingFill || c.lastUpdatedAt !== e.updated || lastKey !== e.order.at(-1) || headers.length !== e.order.length) {
    for (const h of headers) {
      const prev = e.byId.get(h.bubbleId)
      // 读过且有内容、也不在生成中的消息不再重读（长会话每条可能上百 KB）；
      // 空的（占位）只在第一次读、或者它在最后 5 条里时才重读，中间那些本来就空的旧占位不反复读
      if (prev && !generating.has(h.bubbleId) && !e.generating.has(h.bubbleId) && !tail.has(h.bubbleId)) continue
      if (!prev && !fresh && !recent.has(h.bubbleId) && !generating.has(h.bubbleId) && e.order.includes(h.bubbleId)) continue
      const m = normalize(bubble(id, h.bubbleId), h.bubbleId)
      if (m && JSON.stringify(m) !== JSON.stringify(prev)) { e.byId.set(h.bubbleId, m); upserts.push(m) }
    }
    e.order = headers.map((h) => h.bubbleId)
    for (const k of e.byId.keys()) if (!e.order.includes(k)) e.byId.delete(k)
  }
  const status = c.status || ''
  const statusChanged = status !== e.status
  e.updated = c.lastUpdatedAt; e.status = status; e.generating = generating
  touch(id, e)
  e.path = c.workspaceIdentifier?.uri?.fsPath || ''
  e.changed = changedCount(id, c)
  return { fresh, upserts, statusChanged, entry: e, name: c.name || '' }
}
const sidebarBusy = (id) => /in progress|generat|running/i.test(projects.flatMap((p) => p.sessions).find((x) => x.id === id)?.status || '')
const listOf = (e) => e.order.map((k) => e.byId.get(k)).filter(Boolean)
// 空消息（还没填内容的）也占着位置，但不缓存成「已读」

// ---------- Cursor 进程和调试端口 ----------
let conn = ''
function setStatus(c, msg = '', step) {
  conn = c
  out({ t: 'status', conn: c, msg, step })
}
const cursorRunning = () => spawnSync('/usr/bin/pgrep', ['-x', 'Cursor'], { encoding: 'utf8' }).stdout.trim() !== ''
async function portUp() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}
// Cursor 主进程命令行里有没有带调试端口参数
const debugArg = () => spawnSync('/bin/ps', ['-axo', 'args='], { encoding: 'utf8' }).stdout.split('\n').some((l) => l.startsWith('/Applications/Cursor.app/Contents/MacOS/Cursor ') && l.includes(`--remote-debugging-port=${PORT}`))
let portMiss = 0
async function pageTarget() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
    return list.find((t) => t.type === 'page' && /workbench\.html/.test(t.url)) || null
  } catch { return null }
}

let launching = false
async function launch(reason = '') {
  if (launching) return
  launching = true
  try {
    if (!cursorRunning()) {
      setStatus('launching', '正在启动 Cursor…', 1)
      spawn('/usr/bin/open', ['-a', 'Cursor', '--args', `--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true }).unref()
    }
    for (let i = 0; i < 120 && !(await portUp()); i++) {
      if (i === 6 && !cursorRunning()) throw new Error('Cursor 没有启动起来')
      await sleep(500)
    }
    if (!(await portUp())) throw new Error('等了 60 秒，Cursor 的调试端口还没打开')
    setStatus('launching', '等待 Cursor 窗口…', 2)
    for (let i = 0; i < 60 && !(await pageTarget()); i++) await sleep(500)
    if (!(await pageTarget())) throw new Error('Cursor 打开了，但没有找到 Agents 窗口')
    setStatus('connecting', '正在接入…', 3)
    await connect()
  } catch (e) {
    setStatus('error', e.message)
  } finally { launching = false }
}

async function restart() {
  if (!cursorRunning()) return launch()
  setStatus('launching', '正在退出 Cursor（有没保存的内容时 Cursor 会先问你）…', 0)
  spawnSync('/usr/bin/osascript', ['-e', 'tell application "Cursor" to quit'])
  for (let i = 0; i < 40 && cursorRunning(); i++) await sleep(500)
  if (cursorRunning()) return setStatus('no-debug', 'Cursor 没有退出（可能在等你处理保存提示），处理完再点一次')
  await launch()
}

// ---------- CDP ----------
let ws = null, nextId = 0, attached = false
const pending = new Map()
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('没有连上 Cursor'))
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, 10000)
  })
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || '页面脚本出错')
  return r.result?.value
}

async function connect() {
  const t = await pageTarget()
  if (!t) throw new Error('没有找到 Cursor 的 Agents 窗口')
  ws?.close()
  const sock = new WebSocket(t.webSocketDebuggerUrl)
  ws = sock
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('连不上 Cursor 的调试端口')) })
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result); return }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__paneRemoteEmit') onPage(m.params.payload)
    if (m.method === 'Runtime.executionContextsCleared' || m.method === 'Page.frameNavigated') setTimeout(inject, 1500) // 页面重新加载：重新注入
  }
  sock.onclose = () => {
    if (ws !== sock) return
    attached = false
    for (const p of pending.values()) p.reject(new Error('和 Cursor 的连接断了'))
    pending.clear()
    setStatus(cursorRunning() ? 'connecting' : 'not-running', cursorRunning() ? 'Cursor 连接断了，重连中…' : 'Cursor 已关闭')
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable').catch(() => {})
  await cdp('Runtime.addBinding', { name: '__paneRemoteEmit' })
  await inject()
  attached = true
  setStatus('ready', '已接入 Cursor')
}

// 页面里的观察脚本：会话列表 + 当前会话的实时文字 + 待选择的按钮。页面变化合并成 300ms 一批（最多 800ms 一定发一次）
// 版本号：改了观察脚本就加一。页面里留着旧版本时先拆掉再装新的（适配器升级后页面不会自己刷新）
const OBSERVER_VERSION = 3
const OBSERVER = `(() => {
  const emit = (o) => { try { window.__paneRemoteEmit(JSON.stringify(o)) } catch {} }
  if (window.__paneRemote?.version === ${OBSERVER_VERSION}) { window.__paneRemote.flush(true); return 'again' }
  try { window.__paneRemote?.stop?.() } catch {}
  const txt = (e) => (e?.innerText || '').trim()
  function sidebar() {
    const projects = []
    for (const s of document.querySelectorAll('[data-sidebar-workspace-section-root]')) {
      const key = s.getAttribute('data-agent-drop-section-id') || s.getAttribute('data-sidebar-motion-scope') || ''
      if (key === '__projects__') continue
      const label = txt(s.querySelector('[data-sidebar-group-label]')) || (key === '__pinned_agents__' ? '置顶' : key.replace(/^workspace:uri:/, '').replace(/\\/$/, '').split('/').pop() || '其他')
      const sessions = []
      for (const it of s.querySelectorAll('[data-sidebar-item-key^="row:"]')) {
        const id = it.getAttribute('data-sidebar-item-key').slice(4)
        const status = [...it.querySelectorAll('[role=img][aria-label]')].map((i) => i.getAttribute('aria-label')).join(' ')
        const lines = txt(it).split('\\n').map((x) => x.trim()).filter(Boolean)
        const AGE = /(^|\\s)(\\d+(?:mo|[smhdwy])|now)$/i
        const joined = lines.join(' ')
        const age = joined.match(AGE)?.[2] || ''
        const title = joined.replace(AGE, '').trim().slice(0, 120)
        const active = !!it.querySelector('[data-active="true"]') || it.getAttribute('data-active') === 'true'
        sessions.push({ id, title, age, status, active })
      }
      // 同一个工作区可能在侧边栏里出现在两个分组：按工作区合并，会话去重
      const same = projects.find((p) => p.id === key)
      if (same) { for (const x of sessions) if (!same.sessions.some((y) => y.id === x.id)) same.sessions.push(x) }
      else projects.push({ id: key, label, uri: key.startsWith('workspace:uri:') ? key.slice(14) : '', sessions })
    }
    return projects
  }
  function live() {
    const msgs = [...document.querySelectorAll('[data-message-kind]')]
    const last = msgs.filter((m) => m.dataset.messageKind === 'assistant').pop()
    const streaming = !!document.querySelector('[data-streamdown][data-streaming="true"], [data-message-kind="assistant"] [data-streaming="true"]')
    // 输入框附近 / 最后一条消息里的可选按钮（运行命令、接受、跳过之类），手机上原样给出
    const scope = msgs.at(-1)?.parentElement?.parentElement || document
    const choices = [...scope.querySelectorAll('button')].filter((b) => b.offsetParent && /^(run|accept|allow|approve|skip|reject|deny|cancel|keep|undo|continue|always allow|run always)/i.test(txt(b)) && txt(b).length < 30).slice(0, 6).map((b) => txt(b))
    const stop = [...document.querySelectorAll('[data-component^="prompt-input"] button, button[aria-label]')].some((b) => /stop|cancel generat/i.test((b.getAttribute('aria-label') || '') + txt(b)) && b.offsetParent)
    return { lastId: last?.dataset.messageId?.split('/')[0] || '', text: (last?.innerText || '').slice(0, ${MAX_TEXT}), streaming: streaming || stop, choices }
  }
  let lastSb = '', lastLive = '', timer = 0, first = 0
  function flush(force) {
    timer = 0; first = 0
    const sb = JSON.stringify(sidebar())
    if (force || sb !== lastSb) { lastSb = sb; emit({ t: 'sidebar', projects: JSON.parse(sb) }) }
    const lv = JSON.stringify(live())
    if (force || lv !== lastLive) { lastLive = lv; emit({ t: 'live', ...JSON.parse(lv) }) }
  }
  const mo = new MutationObserver(() => {
    const now = Date.now()
    if (!first) first = now
    clearTimeout(timer)
    timer = setTimeout(flush, now - first > 800 ? 0 : 300)
  })
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-active', 'aria-label', 'data-state', 'data-streaming'] })
  window.__paneRemote = { version: ${OBSERVER_VERSION}, flush, stop: () => { mo.disconnect(); clearTimeout(timer) } }
  flush(true)
  return 'ok'
})()`

async function inject() {
  try { await evaluate(OBSERVER) } catch (e) { log('inject', e.message) }
}

// ---------- 页面事件 → 会话列表 / 消息 ----------
let projects = []
let activeId = ''
let watching = '' // 手机在看的会话
let lastLive = null
const prevStatus = new Map()

function onPage(payload) {
  let m
  try { m = JSON.parse(payload) } catch { return }
  if (m.t === 'sidebar') {
    projects = labelProjects(m.projects)
    const all = projects.flatMap((p) => p.sessions)
    activeId = all.find((s) => s.active)?.id || activeId
    // 状态变化（比如从生成中变成完成）交给服务端决定要不要推送
    for (const s of all) {
      const before = prevStatus.get(s.id)
      if (before !== undefined && before !== s.status) out({ t: 'changed', id: s.id, title: s.title, from: before, to: s.status })
      prevStatus.set(s.id, s.status)
    }
    if (prevStatus.size > 500) for (const k of [...prevStatus.keys()].slice(0, prevStatus.size - 500)) prevStatus.delete(k)
    out({ t: 'sessions', projects, active: activeId })
    scheduleMeta()
    if (watching) schedule(0)
  } else if (m.t === 'live') {
    const before = JSON.stringify([lastLive?.choices, !!lastLive?.streaming])
    lastLive = m
    // 当前会话的可选按钮 / 是否在生成：给服务端算待办（没人在看消息时也要报）
    if (JSON.stringify([m.choices, !!m.streaming]) !== before) out({ t: 'live', active: activeId, choices: m.choices || [], streaming: !!m.streaming })
    if (watching && watching === activeId) schedule(0)
  }
}

// 分组名：本地工作区用目录名，Git 仓库用仓库名；重名时加上区分（本地 → 上一级目录，仓库 → 托管平台）
function labelProjects(list) {
  const base = (p) => {
    if (p.id === '__pinned_agents__') return { name: '置顶', hint: '' }
    const loc = p.id.replace(/^workspace:uri:/, '').replace(/^repo:/, '').replace(/\/$/, '')
    const parts = loc.split('/')
    if (p.id.startsWith('repo:')) return { name: parts.at(-1), hint: parts[0].split('.').slice(-2, -1)[0] || parts[0] }
    return { name: parts.at(-1) || '其他', hint: parts.at(-2) || '' }
  }
  const named = list.map((p) => ({ ...p, ...base(p) }))
  const count = {}
  for (const p of named) count[p.name] = (count[p.name] || 0) + 1
  return named.map(({ name, hint, ...p }) => ({ ...p, label: count[name] > 1 && hint ? `${name} · ${hint}` : name }))
}

// 会话元数据（未读用）：会话列表变化后 1.5 秒查一次，最少隔 3 秒
let metaTimer = 0, metaAt = 0
function scheduleMeta() {
  clearTimeout(metaTimer)
  metaTimer = setTimeout(() => {
    metaAt = Date.now()
    out({ t: 'meta', meta: metaFor(projects.flatMap((p) => p.sessions.map((x) => x.id))) })
  }, Math.max(1500, 3000 - (Date.now() - metaAt)))
}
setInterval(() => { if (projects.length) scheduleMeta() }, 30000) // 兜底：页面没变化时数据库里的状态也可能变

// 手机在看的会话：有变化就读数据库，生成中每 700ms、平时每 4s 兜底看一次
let pollTimer = 0
function schedule(ms) {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(pump, ms)
}
function pump() {
  if (!watching) return
  const id = watching
  const r = readSession(id)
  if (!r) { out({ t: 'messages', id, list: [], status: '', missing: true }); return }
  const live = watching === activeId && lastLive ? lastLive : null
  const extra = { loops: loopsOf(id), path: r.entry.path || '', changed: r.entry.changed || 0, status: r.entry.status, generating: r.entry.generating.size > 0 || !!live?.streaming || sidebarBusy(id), choices: live?.choices || [], streamText: live?.streaming ? live.text : '', streamId: live?.streaming ? live.lastId : '' }
  if (r.fresh || pump.sent !== id) { pump.sent = id; out({ t: 'messages', id, list: listOf(r.entry), name: r.name, ...extra }) }
  else if (r.upserts.length || r.statusChanged || JSON.stringify(extra) !== pump.lastExtra) out({ t: 'delta', id, upserts: r.upserts, order: r.entry.order, ...extra })
  pump.lastExtra = JSON.stringify(extra)
  schedule(extra.generating ? 700 : 4000)
}

// ---------- 改动：这个会话改过的文件，原来的内容（Cursor 存在数据库里）对比现在磁盘上的文件 ----------
import fs from 'node:fs'
const MAX_FILES = 40, MAX_DIFF = 40000, MAX_TOTAL = 300000
function changes(id) {
  const c = composer(id)
  if (!c) throw new Error('读不到这个会话')
  const root = c.workspaceIdentifier?.uri?.fsPath || ''
  let entries = Object.entries(c.originalFileStates || {})
  // Cursor 3.26 起新会话的 originalFileStates 是空的，但改动前的原文还按 ofsContent:<会话>:<文件 URI> 存着（走主键范围查）。
  // 这里面也有只读过、没改的文件，没变化的就不列；原文长度 0 当成新建的文件
  const fallback = !entries.length
  if (fallback && openDb()) {
    try {
      const pre = `ofsContent:${id}:`
      entries = db.prepare('SELECT key, length(value) AS n FROM cursorDiskKV WHERE key >= ? AND key < ? LIMIT 400').all(pre, `ofsContent:${id};`)
        .map((r) => [r.key.slice(pre.length), { contentKey: r.key, isNewlyCreated: !Number(r.n) }])
    } catch (e) { log('changes', e.message) }
  }
  const files = []
  let total = 0
  for (const [uri, st] of entries) {
    if (files.length >= MAX_FILES) break
    let file = ''
    try { file = decodeURIComponent(new URL(uri).pathname) } catch { continue }
    const rel = root && file.startsWith(root + '/') ? file.slice(root.length + 1) : file.replace(os.homedir(), '~')
    let original = ''
    if (st?.contentKey && !st.isNewlyCreated) {
      try { const row = (qBubble ||= db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')).get(st.contentKey); original = row ? String(row.value) : '' } catch {}
    }
    const exists = fs.existsSync(file)
    let current = ''
    try { if (exists) { const st2 = fs.statSync(file); current = st2.size > 2e6 ? null : fs.readFileSync(file, 'utf8') } } catch {}
    const item = { file, rel, isNew: !!st?.isNewlyCreated, deleted: !exists, adds: 0, dels: 0, diff: '' }
    if (current === null || original.includes('\0') || (current || '').includes('\0')) { item.binary = true; files.push(item); continue }
    if (original === current || (fallback && st.isNewlyCreated && !exists)) { if (!fallback) { item.same = true; files.push(item) } continue }
    // 系统自带的 diff：原来的内容从标准输入给，不写临时文件
    const r = spawnSync('/usr/bin/diff', ['-u', '--label', 'a/' + rel, '--label', 'b/' + rel, '-', exists ? file : '/dev/null'], { input: original, encoding: 'utf8', maxBuffer: 8 << 20 })
    let diff = r.stdout || ''
    for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) item.adds++; else if (line.startsWith('-') && !line.startsWith('---')) item.dels++ }
    if (diff.length > MAX_DIFF) { diff = diff.slice(0, MAX_DIFF) + '\n…（差异太长，后面截掉了）'; item.truncated = true }
    if (total + diff.length > MAX_TOTAL) { item.diff = ''; item.omitted = true } else { item.diff = diff; total += diff.length }
    files.push(item)
  }
  return { path: root, total: fallback ? files.length : entries.length, shown: files.length, files }
}

// ---------- 操作 ----------
async function needReady() {
  if (conn === 'ready' && attached) return
  if (conn === 'no-debug') throw new Error('Cursor 开着但没有调试端口，需要先重启接入')
  await launch()
  if (conn !== 'ready') throw new Error('Cursor 还没准备好')
}
const js = (v) => JSON.stringify(v)
async function openSession(id) {
  const ok = await evaluate(`(() => { const it = document.querySelector('[data-sidebar-item-key="row:' + ${js(id)} + '"]'); const b = it?.querySelector('button, [role=button]') || it; b?.click(); return !!b })()`)
  if (!ok) throw new Error('侧边栏里没找到这个会话（可能被归档或折叠了）')
  for (let i = 0; i < 20 && activeId !== id; i++) await sleep(150)
}
// 找目标会话自己的输入框：Cursor 3 每个打开的会话是一个标签页（data-glass-agent-id=会话 ID），可能同时开着好几个，
// 不能拿页面上第一个输入框（会发进别的会话）。会话刚切过去时输入框要一会儿才渲染出来，最多等 3 秒
async function focusEditor(id) {
  const expr = `(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 }
    const sel = '[data-component="prompt-input-editor"] [contenteditable="true"]'
    const id = ${js(id || '')}
    // 外层的总面板也挂着 data-glass-agent-id（值是当前会话），会把所有标签页的输入框都包进去：
    // 只认「离输入框最近的那一层」是目标会话的；藏在后面的标签页拿不到焦点，挨个试
    const all = [...document.querySelectorAll(sel)].filter(vis)
    const cands = id ? all.filter((e) => e.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === id) : all
    for (const e of cands) {
      // 输入框里已经有字（多半是在电脑上打了一半）：不往里写，免得两段拼在一起发出去
      if ((e.innerText || '').trim()) return 'has-draft'
      e.focus()
      if (document.activeElement === e) return true
    }
    return false
  })()`
  for (let i = 0; i < 40; i++) {
    const r = await evaluate(expr)
    if (r === 'has-draft') throw new Error('Cursor 里这个会话的输入框有没发出去的内容（可能是你在电脑上打的），没有往里写；先在电脑上发掉或清空')
    if (r) return
    await sleep(150)
  }
  throw new Error(id ? '没找到这个会话的输入框（会话可能还没在 Cursor 里打开完，或被折叠了），再发一次试试' : '没找到 Cursor 的输入框')
}
async function typeAndSend(text, id) {
  await focusEditor(id)
  await cdp('Input.insertText', { text })
  await sleep(120)
  for (const type of ['rawKeyDown', 'char', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'char' ? { text: '\r' } : {}) })
}

// 会话行上的操作按钮（Pin / Unpin / Archive）：平时藏着、悬停才显示，但一直在 DOM 里，直接 click 就行
async function rowAction(id, labels) {
  const r = await evaluate(`(() => {
    const it = document.querySelector('[data-sidebar-item-key="row:' + ${js(id)} + '"]')
    if (!it) return 'no-row'
    const b = [...it.querySelectorAll('button[aria-label]')].find((x) => ${js(labels)}.includes(x.getAttribute('aria-label')))
    if (!b) return 'no-button'
    b.click(); return b.getAttribute('aria-label')
  })()`)
  if (r === 'no-row') throw new Error('侧边栏里没找到这个会话（可能被归档或折叠了）')
  if (r === 'no-button') throw new Error('Cursor 里没找到这个操作按钮（Cursor 可能改版了）')
  return r
}
// 分叉：Cursor 在每一轮回复后面有「Fork chat」，挂在 turn-actions:human:<这一轮用户消息的 id> 那一行。
// 对话是虚拟滚动的，太早的轮次不在 DOM 里：先滚到底找，找不到就一屏一屏往上滚
/** 手机上的消息 id → Cursor 自己的消息（bubble）id。从会话记录读出来的消息 id 是行号（t12…），Cursor 页面上的分叉按钮
 *  按 bubble id 定位：按用户消息原文去数据库里找同样文字的用户 bubble（同样的话说过几次就按从后往前第几次对上） */
function bubbleOf(id, mid) {
  if (!/^t\d/.test(mid)) return mid
  const e = cache.get(id)
  const m = e?.byId.get(mid)
  if (!m || m.role !== 'user' || !openDb()) throw new Error('这一轮在 Cursor 里找不到对应的消息')
  const text = m.text.trim()
  const fromEnd = e.order.slice(e.order.indexOf(mid) + 1).filter((k) => { const x = e.byId.get(k); return x?.role === 'user' && x.text.trim() === text }).length
  const rows = db.prepare(`SELECT key, json_extract(value,'$.text') AS t, json_extract(value,'$.createdAt') AS c FROM cursorDiskKV WHERE key >= ? AND key < ? AND json_extract(value,'$.type') = 1`)
    .all(`bubbleId:${id}:`, `bubbleId:${id};`).filter((r) => String(r.t || '').trim() === text).sort((a, b) => String(a.c).localeCompare(String(b.c)))
  // 会话记录偶尔把同一条用户消息记两遍（数据库里只有一个 bubble）：数多了就落到最早那个
  const hit = rows[Math.max(0, rows.length - 1 - fromEnd)]
  if (!hit) throw new Error('这一轮在 Cursor 里找不到对应的消息')
  return hit.key.slice(`bubbleId:${id}:`.length)
}

async function forkAt(id, bubble) {
  bubble = bubble ? bubbleOf(id, bubble) : ''
  if (id !== activeId) { await openSession(id); await sleep(800) }
  const find = `(() => {
    const bubble = ${js(bubble || '')}
    const rows = [...document.querySelectorAll('[data-react-transcript-row-kind="turnActions"]')].filter((r) => r.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === ${js(id)} || !r.closest('[data-glass-agent-id]'))
    const row = bubble ? rows.find((r) => (r.getAttribute('data-react-transcript-row-key') || '').startsWith('turn-actions:human:' + bubble.slice(0, 20))) : rows.at(-1)
    const b = row && [...row.querySelectorAll('button[aria-label="Fork chat"]')][0]
    if (b) { b.click(); return 'clicked' }
    const sc = rows[0]?.closest('[data-virtualization-owner]') || document.querySelector('[data-glass-agent-id=' + JSON.stringify(${js(id)}) + '] [data-virtualization-owner]')
    if (!sc) return 'no-scroller'
    if (!bubble) { if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 4) { sc.scrollTop = sc.scrollHeight; return 'scrolled' } return 'not-found' }
    if (sc.scrollTop <= 0) return 'not-found'
    sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight * 0.8); return 'scrolled'
  })()`
  const before = activeId
  for (let i = 0; i < 60; i++) {
    const r = await evaluate(find)
    if (r === 'clicked') break
    if (r === 'not-found' || r === 'no-scroller' || i === 59) throw new Error(bubble ? '在 Cursor 里没找到这一轮的分叉按钮（这一轮可能还没结束）' : '在 Cursor 里没找到分叉按钮（会话可能还在生成）')
    await sleep(r === 'scrolled' ? 250 : 150)
  }
  // 分叉后 Cursor 切到新会话：等侧边栏报出新的当前会话
  for (let i = 0; i < 40 && activeId === before; i++) await sleep(150)
  if (activeId === before) throw new Error('点了分叉，但 Cursor 没有切到新会话')
  schedule(300)
  return { id: activeId }
}

// ---------- 用量：跟 Cursor 设置里的 Usage 同一个接口，用 Cursor 本地的登录令牌（只在内存里用，不输出、不落盘） ----------
function itemValue(key) {
  if (!openDb()) return ''
  try { const r = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key); return r ? String(r.value) : '' } catch { return '' }
}
async function usage() {
  const tok = itemValue('cursorAuth/accessToken')
  if (!tok) throw new Error('Cursor 还没登录')
  const r = await fetch('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'connect-protocol-version': '1' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  })
  if (r.status === 401 || r.status === 403) throw new Error('Cursor 的登录过期了，在电脑上打开一次 Cursor 就会刷新')
  if (!r.ok) throw new Error(`查询用量失败（${r.status}）`)
  const d = await r.json()
  const p = d.planUsage || {}
  const num = (v) => (v == null || v === '' ? null : Number(v))
  return {
    plan: itemValue('cursorAuth/stripeMembershipType') || '',
    start: num(d.billingCycleStart), end: num(d.billingCycleEnd),
    // 金额单位是美分
    used: num(p.totalSpend), limit: num(p.limit), remaining: num(p.remaining),
    autoPct: num(p.autoPercentUsed), apiPct: num(p.apiPercentUsed), totalPct: num(p.totalPercentUsed),
    bonus: !!p.remainingBonus,
    onDemand: d.spendLimitUsage ? { limitType: d.spendLimitUsage.limitType || '', used: num(d.spendLimitUsage.individualUsed ?? d.spendLimitUsage.totalSpend), limit: num(d.spendLimitUsage.individualLimit ?? d.spendLimitUsage.pooledLimit) } : null,
    message: d.displayMessage || '',
    at: Date.now(),
  }
}

// ---------- 模型：会话的在 composerData.modelConfig = {modelName, maxMode, selectedModels:[{modelId, parameters:[{id, value}]}]}；
// 可选模型来自 Cursor 自己存的设置（applicationUser.availableDefaultModels2 + aiSettings 里的开关），和输入框下方选择器里列的是同一批。
// 切换走页面上的选择器（menu-popup，base-ui 菜单）：按钮 click 能打开；子菜单（Model / Effort）要悬停才展开；菜单项 click 不认，focus 后发 Enter 才选中。
// 注意：在会话里选模型，Cursor 会同时把它记成新会话的默认模型（aiSettings.modelConfig.composer），思考等级也会记进这个模型的偏好（modelParameterPreferences）
const EFFORT_PARAMS = ['reasoning_effort', 'effort', 'reasoning']
let catalogCache = null, catalogAt = 0
function catalog() {
  if (catalogCache && Date.now() - catalogAt < 30000) return catalogCache
  let v = null
  try { v = JSON.parse(itemValue('src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser') || 'null') } catch {}
  const all = v?.availableDefaultModels2
  if (!Array.isArray(all)) return []
  const ai = v.aiSettings || {}
  const on = new Set(ai.modelOverrideEnabled || []), off = new Set(ai.modelOverrideDisabled || [])
  const prefs = ai.modelParameterPreferences || {}
  const list = []
  for (const m of all) {
    // 选择器里列的：默认开着且没被关掉的，加上在设置里手动打开的；Auto（default）排第一
    if (!m?.name || !((m.defaultOn && !off.has(m.name)) || on.has(m.name)) || m.supportsAgent === false) continue
    const defs = m.parameterDefinitions || []
    const ep = EFFORT_PARAMS.map((k) => defs.find((d) => d.id === k && d.parameterType?.enumParameter)).find(Boolean)
    const values = ep?.parameterType.enumParameter.values || []
    const dv = (m.variants || []).find((x) => x.isDefaultNonMaxConfig) || (m.variants || [])[0]
    const pv = (ps, k) => (ps || []).find((p) => p.id === k)?.value || ''
    // 默认等级：这个模型上次用的（Cursor 记在偏好里，切过去时会沿用），没有就用 Cursor 给的默认
    const def = ep ? pv(prefs[m.name]?.parameters, ep.id) || pv(dv?.parameterValues, ep.id) : ''
    list.push({ id: m.name, label: m.name === 'default' ? 'Auto' : m.clientDisplayName || m.inputboxShortModelName || m.name, efforts: values.map((x) => x.value), default: def, param: ep?.id || '', pname: ep?.name || 'Effort', names: Object.fromEntries(values.map((x) => [x.value, x.displayName || x.value])) })
  }
  catalogCache = list; catalogAt = Date.now()
  return list
}
function modelConfigOf(id) {
  if (!openDb()) throw new Error('读不了 Cursor 的数据库')
  try { const r = db.prepare("SELECT json_extract(value,'$.modelConfig') AS m FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`); return r?.m ? JSON.parse(r.m) : null } catch { return null }
}
// 会话在不在生成：数据库里的状态 / 生成中的消息，加上页面上的「停止」按钮（当前打开的会话）
function sessionBusy(id) {
  let st = '', gen = 0
  try { const r = db.prepare("SELECT json_extract(value,'$.status') AS s, json_array_length(json_extract(value,'$.generatingBubbleIds')) AS g FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`); st = r?.s || ''; gen = Number(r?.g) || 0 } catch {}
  return gen > 0 || /^generating$/i.test(st) || (id === activeId && !!lastLive?.streaming)
}
// 刚切过的：Cursor 不会马上把会话的 modelConfig 写进数据库（有时要等到下一次发消息），先记在内存里，数据库对上了再丢掉
const switched = new Map() // id → { model, effort, at }
function sessionModel(id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error('bad id')
  const mc = modelConfigOf(id)
  const models = catalog()
  const pub = models.map(({ param, pname, names, ...m }) => m)
  if (!mc) return { agent: 'cursor-ide', models: pub, current: { model: '', id: '', effort: '' }, global: true, busy: false }
  const sel = (mc.selectedModels || [])[0] || {}
  const param = (k) => (sel.parameters || []).find((p) => p.id === k)?.value || ''
  let model = sel.modelId || mc.modelName || ''
  let m = models.find((x) => x.id === model)
  // 参数没记的（刚切过去还没动过等级）就是在用默认等级
  let effort = (m?.param && param(m.param)) || EFFORT_PARAMS.map(param).find(Boolean) || m?.default || ''
  let extra = { maxMode: !!mc.maxMode, fast: param('fast') === 'true', context: param('context') }
  const sw = switched.get(id)
  if (sw && (sw.model !== model || sw.effort !== effort) && Date.now() - sw.at < 3600000) {
    model = sw.model; m = models.find((x) => x.id === model); effort = sw.effort; extra = {} // 数据库里的 Fast / 上下文也是旧的，不报
  } else switched.delete(id)
  return { agent: 'cursor-ide', models: pub, current: { model: m?.label || model, id: model, effort, ...extra }, global: true, busy: sessionBusy(id) }
}

// 页面里操作选择器的一步。每一步开头都确认：侧边栏当前会话就是目标会话、选择器属于它（不会点到别的会话）
const PICKER_JS = (id) => `
  const id = ${js(id)}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 }
  const rows = [...document.querySelectorAll('[data-sidebar-item-key^="row:"]')].filter((it) => it.querySelector('[data-active="true"]') || it.getAttribute('data-active') === 'true')
  if (rows.length !== 1 || rows[0].getAttribute('data-sidebar-item-key') !== 'row:' + id) return 'not-active'
  // 每个打开的会话标签页各有一个选择器：认离它最近的 data-glass-agent-id；新建还没发过消息的会话没有这一层，这时只有一个看得见的选择器才用
  const pickers = [...document.querySelectorAll('[data-glass-model-picker-wrapper] button')].filter(vis)
  const mine = pickers.filter((b) => b.closest('[data-glass-agent-id]')?.getAttribute('data-glass-agent-id') === id)
  const picker = mine.length === 1 ? mine[0] : !mine.length && pickers.length === 1 && !pickers[0].closest('[data-glass-agent-id]') ? pickers[0] : null
  if (!picker) return 'no-picker'
  const popups = () => [...document.querySelectorAll('[role=menu][data-component=menu-popup]')]
  const close = async () => { for (let i = 0; i < 3 && popups().length; i++) { (popups().at(-1) || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })); await sleep(200) } }
  const hover = (el) => { const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerType: 'mouse', pointerId: 1, isPrimary: true }; for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)) }
  const choose = (el) => { el.scrollIntoView({ block: 'nearest' }); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })) }
  const wait = async (f, n = 15) => { for (let i = 0; i < n; i++) { const v = f(); if (v) return v; await sleep(100) } return null }
  const label = (el) => el?.querySelector('[data-component=menu-item-content]')?.innerText.trim() || ''
  // 打开选择器，拿最外层菜单：选了具体模型时是参数页（selected-model-parameters-submenu-menu），选了 Auto 时是 selected-auto-menu
  const openRoot = async () => {
    await close()
    picker.click()
    return wait(() => popups().find((p) => !p.hasAttribute('data-submenu')))
  }
  // 再悬停某个子菜单入口（Model / Effort），等子菜单出来
  const openSub = async (name, testid) => {
    const root = await openRoot()
    if (!root) return null
    const tr = [...root.querySelectorAll('[data-component=menu-submenu-trigger]')].find((x) => label(x) === name)
    if (!tr) return 'no-trigger'
    hover(tr)
    return (await wait(() => document.querySelector('[data-testid="' + testid + '"]'))) || null
  }
  // 读当前值：参数页的 aria-label 是「<模型 id> parameters」，思考等级那一行（Effort / Reasoning，名字看模型）右边是等级的显示名
  const readCur = async (pname) => {
    const root = await openRoot()
    if (!root) return null
    const name = root.querySelector('[data-component=menu-layout]')?.getAttribute('aria-label') || ''
    const ef = [...root.querySelectorAll('[data-component=menu-submenu-trigger]')].find((x) => label(x) === pname)
    return { model: root.getAttribute('data-testid') === 'selected-auto-menu' ? 'default' : name.replace(/ parameters$/, ''), effort: ef?.querySelector('[data-component=menu-submenu-right-section]')?.innerText.trim() || '' }
  }
`
async function pickerStep(id, body) {
  const r = await evaluate(`(async () => { ${PICKER_JS(id)}\n try { ${body} } finally { await close() } })()`)
  const ERR = {
    'not-active': '没能在 Cursor 里切到这个会话，没有动选择器',
    'no-picker': '没找到这个会话的模型选择器（会话可能还没打开完），再试一次',
    'no-menu': '模型选择器没有打开（Cursor 可能改版了）',
    'no-item': 'Cursor 的模型选择器里没有这个模型（可能在 Cursor 设置里关掉了）',
    'no-effort': '选择器里没有这个思考等级',
  }
  if (r && typeof r === 'object') return r
  if (r !== 'ok') throw new Error(ERR[r] || `切换失败（${r}）`)
}

let switching = ''
async function setModel(id, model, effort) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error('bad id')
  if (switching) throw new Error('这个会话正在切换模型')
  const m = catalog().find((x) => x.id === model)
  if (!m) throw new Error('Cursor 的模型选择器里没有这个模型（可能在 Cursor 设置里关掉了）')
  if (effort && !m.efforts.includes(effort)) throw new Error(m.efforts.length ? '这个模型没有这个思考等级' : '这个模型不支持调思考等级')
  if (!modelConfigOf(id)) throw new Error('读不到这个会话')
  await needReady()
  if (sessionBusy(id)) throw new Error('会话正在生成，这一轮停下后再切换')
  switching = id
  try {
    if (id !== activeId) { await openSession(id); await sleep(600) }
    if (activeId !== id) throw new Error('没能在 Cursor 里切到这个会话，没有动选择器')
    if (sessionBusy(id)) throw new Error('会话正在生成，这一轮停下后再切换')
    // 当前值从页面上的选择器读（数据库会晚一拍）
    const read = async () => (await pickerStep(id, `const c = await readCur(${js(m.pname)}); return c || 'no-menu'`)) || {}
    const want = effort && m.param ? m.names[effort] || effort : ''
    let cur = await read()
    // 1. 模型：Model 子菜单里的 model-item-<id>（Auto 是 auto-mode-select）
    if (cur.model !== model) {
      const item = model === 'default' ? '[data-testid=auto-mode-select]' : `[data-testid="model-item-${model}"]`
      await pickerStep(id, `
        const sub = await openSub('Model', 'selected-model-list-submenu')
        if (!sub || sub === 'no-trigger') return 'no-menu'
        const it = sub.querySelector(${js(item)})
        if (!it) return 'no-item'
        choose(it); await sleep(400); return 'ok'`)
      await sleep(300)
      cur = await read()
      if (cur.model !== model) throw new Error('点了切换，但 Cursor 里这个会话的模型没变')
    }
    // 2. 思考等级：parameter-submenu-<参数 id> 里按显示名找（Low / Medium / Extra High…）
    if (want && cur.effort !== want) {
      await pickerStep(id, `
        const sub = await openSub(${js(m.pname)}, ${js('parameter-submenu-' + m.param)})
        if (!sub || sub === 'no-trigger') return sub === 'no-trigger' ? 'no-effort' : 'no-menu'
        const it = [...sub.querySelectorAll('[role=menuitem]')].find((x) => label(x) === ${js(want)})
        if (!it) return 'no-effort'
        choose(it); await sleep(400); return 'ok'`)
      await sleep(300)
      cur = await read()
      if (cur.model !== model || cur.effort !== want) throw new Error('模型切过去了，但思考等级没变')
    }
    // 3. 确认过了：数据库还没写的这段时间先用内存里的
    const names = Object.entries(m.names)
    switched.set(id, { model, effort: m.param ? names.find(([, n]) => n === cur.effort)?.[0] || effort || m.default : '', at: Date.now() })
    catalogCache = null
    return sessionModel(id)
  } finally { switching = '' }
}

async function handle(m) {
  switch (m.t) {
    case 'watch': watching = m.id || ''; pump.sent = ''; if (watching) { if (attached) await evaluate('window.__paneRemote?.flush(true)').catch(() => {}); schedule(0) } return
    case 'launch': return launch()
    case 'usage': return usage()
    case 'restart': return restart()
    case 'refresh': if (attached) return evaluate('window.__paneRemote?.flush(true)'); return
    case 'changes': return changes(String(m.id || ''))
    case 'model': return sessionModel(String(m.id || ''))
    case 'model-set': return setModel(String(m.id || ''), String(m.model || ''), m.effort ? String(m.effort) : '')
    case 'open': await needReady(); return openSession(m.id)
    case 'send': {
      const text = String(m.text || '').slice(0, 20000)
      if (!text.trim()) throw new Error('空消息')
      await needReady()
      if (m.id && m.id !== activeId) await openSession(m.id)
      await typeAndSend(text, m.id || activeId)
      schedule(300)
      return
    }
    case 'new': {
      await needReady()
      const ok = await evaluate(`(() => {
        const sec = ${js(m.project || '')} && document.querySelector('[data-agent-drop-section-id=' + JSON.stringify(${js(m.project || '')}) + ']')
        const b = (sec && [...sec.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === 'New Agent')) || [...document.querySelectorAll('button,[role=button]')].find((x) => x.innerText.trim() === 'New Chat')
        b?.click(); return !!b })()`)
      if (!ok) throw new Error('没找到新建按钮')
      await sleep(600)
      // 新建后 Cursor 切到了新会话：等侧边栏报出新的当前会话，再往它的输入框里写
      const before = activeId
      for (let i = 0; i < 20 && activeId === before; i++) await sleep(150)
      if (m.text) { await typeAndSend(String(m.text).slice(0, 20000), activeId !== before ? activeId : ''); await sleep(800) }
      return
    }
    case 'stop': {
      await needReady()
      const ok = await evaluate(`(() => { const bs = [...document.querySelectorAll('button')].filter((x) => x.offsetParent); const b = bs.find((x) => x.getAttribute('aria-label') === 'Stop generation') || bs.find((x) => /stop generat|cancel generat/i.test((x.getAttribute('aria-label') || '') + ' ' + x.innerText)); b?.click(); return !!b })()`)
      if (!ok) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).then(() => cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }))
      return
    }
    case 'pin': {
      await needReady()
      await rowAction(String(m.id || ''), m.on === false ? ['Unpin'] : ['Pin'])
      schedule(300)
      return
    }
    case 'archive': {
      await needReady()
      const id = String(m.id || '')
      await rowAction(id, ['Archive'])
      for (let i = 0; i < 20; i++) { if (!(await evaluate(`!!document.querySelector('[data-sidebar-item-key="row:' + ${js(id)} + '"]')`))) break; await sleep(150) }
      schedule(300)
      return
    }
    case 'bubble': return { bubble: bubbleOf(String(m.id || ''), String(m.mid || '')) } // 只读：手机消息 id → Cursor 消息 id（排查分叉用）
    case 'fork': {
      await needReady()
      return forkAt(String(m.id || ''), m.bubble ? String(m.bubble) : '')
    }
    case 'choose': {
      await needReady()
      if (m.id && m.id !== activeId) { await openSession(m.id); await sleep(800) }
      const ok = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.innerText.trim() === ${js(String(m.label || ''))}); b?.click(); return !!b })()`)
      if (!ok) throw new Error('这个选项已经不在了')
      schedule(300)
      return
    }
  }
}

// ---------- 状态巡检：Cursor 有没有开、有没有调试端口、连接是否还在 ----------
async function check() {
  if (launching) return
  const running = cursorRunning()
  if (!running) { if (conn !== 'not-running') { ws?.close(); attached = false; setStatus('not-running', 'Cursor 没有打开') } return }
  if (!(await portUp())) {
    // 端口一时没答（睡眠刚醒、Cursor 主线程忙）不等于没开调试端口：进程命令行带着端口参数就只是暂时连不上，
    // 连续 3 次（15 秒）没答才算掉线；命令行里没有端口参数才是真的「不是遥控方式启动的」
    if (debugArg()) { if (++portMiss >= 3 && conn === 'ready') { ws?.close(); attached = false; setStatus('error', 'Cursor 的调试端口没有响应，稍后自动重试') } return }
    if (conn !== 'no-debug') setStatus('no-debug', 'Cursor 开着，但不是用调试端口启动的')
    return
  }
  portMiss = 0
  if (!attached || !ws || ws.readyState !== 1) {
    try { setStatus('connecting', '正在接入…'); await connect() } catch (e) { setStatus('error', e.message) }
  } else if (conn !== 'ready') setStatus('ready', '已接入 Cursor') // 之前误判过，连接其实一直在
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  handle(m).then((data) => m.req && out({ t: 'result', req: m.req, ok: true, ...(data && typeof data === 'object' ? { data } : {}) }), (e) => m.req && out({ t: 'result', req: m.req, ok: false, error: e.message }))
})
rl.on('close', () => { ws?.close(); try { db?.close() } catch {} process.exit(0) })
setInterval(check, 5000)
await check()
// 自检：内存（给服务端日志看）
setInterval(() => log(`mem rss=${Math.round(process.memoryUsage().rss / 1048576)}MB cache=${cache.size} watching=${watching ? 1 : 0}`), 10 * 60000)
