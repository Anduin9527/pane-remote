// Cursor 映射：在电脑上接管 Cursor IDE（Electron）的页面，把会话 / 消息整理成我们自己的数据，手机端自己渲染。
// 不传画面，只传数据：会话列表、状态来自页面（注入一段只读观察脚本），完整消息来自 Cursor 自己的本地数据库（只读）。
// 由 bridge 的 cursor-ide 命令启动（pane-remote enable cursor 开启），stdin / stdout 每行一个 JSON。
//
// 收（服务端 → 这里）：
//   watch{id}            手机在看哪个会话（空 = 没人看消息，只保留会话列表监听）
//   launch / restart     启动 Cursor（没开时）/ 正常退出再带调试端口重开（开着但没调试端口时，要手机那头确认过）
//   open{id} send{id,text} stop new{project} choose{label} refresh
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

// 会话消息缓存：id → { updated, order:[bid], byId: Map(bid → msg), status, generating:Set }，按最近使用淘汰
const cache = new Map()
function touch(id, entry) { cache.delete(id); cache.set(id, entry); while (cache.size > MAX_SESSIONS) cache.delete(cache.keys().next().value) }

/** 读一个会话：第一次读最近 MAX_MSGS 条；之后只读新出现的和正在生成的消息。返回变化 */
function readSession(id) {
  const c = composer(id)
  if (!c) return null
  const headers = (c.fullConversationHeadersOnly || []).slice(-MAX_MSGS)
  const generating = new Set(c.generatingBubbleIds || [])
  let e = cache.get(id)
  const fresh = !e
  if (!e) e = { updated: 0, order: [], byId: new Map(), status: '', generating: new Set() }
  const upserts = []
  // 会话还没结束（或页面上正在生成）时，最后几条每次都重读：Cursor 先写一条空消息，生成完再把内容填进去
  const busy = generating.size > 0 || e.generating.size > 0 || !/^(completed|aborted|error)$/i.test(c.status || '') || (watching === id && !!lastLive?.streaming)
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
  e.changed = Object.keys(c.originalFileStates || {}).length
  return { fresh, upserts, statusChanged, entry: e, name: c.name || '' }
}
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
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) })).ok } catch { return false }
}
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
  const extra = { path: r.entry.path || '', changed: r.entry.changed || 0, status: r.entry.status, generating: r.entry.generating.size > 0 || !!live?.streaming, choices: live?.choices || [], streamText: live?.streaming ? live.text : '', streamId: live?.streaming ? live.lastId : '' }
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
  const entries = Object.entries(c.originalFileStates || {})
  const files = []
  let total = 0
  for (const [uri, st] of entries.slice(0, MAX_FILES)) {
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
    if (original === current) { item.same = true; files.push(item); continue }
    // 系统自带的 diff：原来的内容从标准输入给，不写临时文件
    const r = spawnSync('/usr/bin/diff', ['-u', '--label', 'a/' + rel, '--label', 'b/' + rel, '-', exists ? file : '/dev/null'], { input: original, encoding: 'utf8', maxBuffer: 8 << 20 })
    let diff = r.stdout || ''
    for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) item.adds++; else if (line.startsWith('-') && !line.startsWith('---')) item.dels++ }
    if (diff.length > MAX_DIFF) { diff = diff.slice(0, MAX_DIFF) + '\n…（差异太长，后面截掉了）'; item.truncated = true }
    if (total + diff.length > MAX_TOTAL) { item.diff = ''; item.omitted = true } else { item.diff = diff; total += diff.length }
    files.push(item)
  }
  return { path: root, total: entries.length, shown: files.length, files }
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
async function forkAt(id, bubble) {
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

async function handle(m) {
  switch (m.t) {
    case 'watch': watching = m.id || ''; pump.sent = ''; if (watching) { if (attached) await evaluate('window.__paneRemote?.flush(true)').catch(() => {}); schedule(0) } return
    case 'launch': return launch()
    case 'usage': return usage()
    case 'restart': return restart()
    case 'refresh': if (attached) return evaluate('window.__paneRemote?.flush(true)'); return
    case 'changes': return changes(String(m.id || ''))
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
  if (!(await portUp())) { if (conn !== 'no-debug') setStatus('no-debug', 'Cursor 开着，但不是用调试端口启动的') ; return }
  if (!attached || !ws || ws.readyState !== 1) {
    try { setStatus('connecting', '正在接入…'); await connect() } catch (e) { setStatus('error', e.message) }
  }
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
