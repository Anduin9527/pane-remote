// pane-remote 服务：手机网页（PWA）的后端。只监听 127.0.0.1，由 `tailscale serve` 对 tailnet 提供 HTTPS。
// 两种部署（见 config.mjs）：
//   local  跑在电脑上，直接执行 agent/bridge
//   relay  跑在中转服务器上，经 SSH 反向隧道执行电脑上的 bridge（authorized_keys 里的 forced command）
//   GET  /api/panes              pane 列表
//   GET  /api/stream?pane=N[&since=序号]  SSE：size（列数行数）、full（全部行）、delta（只含变化的行）、resume（手里的画面已是最新）、ping
//                                每帧带递增序号（SSE id）；重连时带上 since 或 Last-Event-ID，序号对得上就不重发整屏
//   POST /api/send {pane, data}  把 data 原样发进 pane（方向键、回车等用控制序列）
//   POST /api/pane/{spawn|split|kill|title|focus}  管理：新标签页/拆分（可带启动命令）、关闭、改标题、电脑上切过去
//   GET  /api/push/key、POST /api/push/subscribe|unsubscribe|status|test  推送订阅（见 push.mjs）
//   GET  /api/states             每个 pane 的状态：waiting / running / idle、等待的问题、有没有未读
//   GET  /api/claude?pane=N      这个 pane 里 Claude 会话的信息（会话 ID、账号、目录），没有就是 {}
//   GET  /api/transcript?pane=N  这个 pane 里 Claude 会话最近的对话消息（对话视图用）
//   POST /api/reconnect {pane}     手动重连：重建这个 pane 的画面通道、清缓存；relay 模式下电脑不通时重建 ssh 共享连接
//   GET  /api/crons?pane=N[&fresh]  这个 pane 里 Claude 会话的定时任务（还在的、最近停掉的、上次结果）
//   POST /api/pane/claude {pane, mode: fork|new, where: right|bottom|tab}  分叉当前会话 / 同目录新开 Claude
//   GET  /api/ls?path=…          列目录（预览地址栏的路径提示，只允许家目录和 /tmp）
//   GET  /api/dirs               新建 pane 可选的目录：当前开着的、以前见过的、Claude 项目里的，按最近排序
//   GET  /api/config             给前端的配置：新建 pane 的启动命令、开了哪些模块
//   GET|POST /api/push/prefs     推送偏好：{stop} 回合结束是否也推
//   WS   /api/preview             预览：电脑上无界面 Chrome 的画面（二进制 JPEG，前面一条 JSON 帧头）和操作通道
//   POST /api/upload?name=…      请求体是文件原始字节（最大 25MB），存到电脑的 ~/Downloads/pane-remote/，返回 {path}
// 身份：只认 tailscale serve 注入的 Tailscale-User-Login，且必须在 allowedLogins 里；local 模式还要求 Host 是 serveHosts 之一。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as push from './push.mjs'
import { initCursor, cursorStream, cursorCmd, cursorSummary } from './cursor.mjs'
import { WebSocketServer } from 'ws'
import zlib from 'node:zlib'
import { config, APP_DIR, CONFIG_PATH } from './config.mjs'

const PORT = config.port
const ALLOWED = new Set(config.allowedLogins)
const LINES = Number(config.scrollbackLines) || 300
const HOME = process.env.HOME
const PUBLIC = path.join(APP_DIR, 'public') // 前端构建产物
const RELAY = config.mode === 'relay'
const BRIDGE = path.join(APP_DIR, 'agent/bridge')

// relay 模式：经反向隧道 ssh 到电脑，命令由那边的 forced command（agent/bridge）执行
const SSH_ARGS = RELAY ? [
  '-F', '/dev/null',
  '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes',
  '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${HOME}/.ssh/known_hosts`,
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${HOME}/.ssh/cm-pane-remote-%C`,
  '-o', 'ControlPersist=10m',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=15',
  '-i', config.relay.identity,
  '-p', String(config.relay.port),
  config.relay.target,
] : []
if (RELAY && !/^[\w.-]+@[\w.:-]+$/.test(config.relay.target || '')) throw new Error('relay 模式要在配置里写 relay.target（电脑上的用户名@127.0.0.1）')

// local 模式直接执行 bridge，命令放在 SSH_ORIGINAL_COMMAND 里（跟 forced command 的接口一致，bridge 不用区分两种模式）
const BRIDGE_ENV = { ...process.env, PANE_REMOTE_BRIDGE_ENV: path.join(path.dirname(CONFIG_PATH), 'bridge.env') }
function bridgeProc(command, stdio) {
  return RELAY
    ? spawn('ssh', [...SSH_ARGS, command], { stdio })
    : spawn(BRIDGE, [], { stdio, env: { ...BRIDGE_ENV, SSH_ORIGINAL_COMMAND: command } })
}
function bridge(command) {
  return new Promise((resolve, reject) => {
    const done = (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop()))
      else resolve(stdout)
    }
    const opts = { maxBuffer: 8 << 20, timeout: 10000 }
    if (RELAY) execFile('ssh', [...SSH_ARGS, command], opts, done)
    else execFile(BRIDGE, [], { ...opts, env: { ...BRIDGE_ENV, SSH_ORIGINAL_COMMAND: command } }, done)
  })
}

// 见过的 pane 目录记下来（重启不丢），新建 pane 时能选回以前开过的目录
const DIRS_FILE = path.join(config.dataDir, 'dirs.json')
let seenDirs = {}
try { seenDirs = JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8')) } catch {}
let dirsDirty = false
function noteDirs(list) {
  const now = Math.floor(Date.now() / 1000)
  for (const p of list) if (p.dir?.startsWith('/')) { seenDirs[p.dir] = now; dirsDirty = true }
}
setInterval(() => {
  if (!dirsDirty) return
  dirsDirty = false
  const keep = Object.entries(seenDirs).sort((a, b) => b[1] - a[1]).slice(0, 200)
  seenDirs = Object.fromEntries(keep)
  fs.writeFile(DIRS_FILE, JSON.stringify(seenDirs), { mode: 0o600 }, () => {})
}, 30000)
let macDirs = { at: 0, list: [] }
async function allDirs() {
  if (Date.now() - macDirs.at > 5 * 60000) {
    try { macDirs = { at: Date.now(), list: JSON.parse(await bridge('dirs')) } } catch (e) { console.log(`dirs: ${e.message}`) }
  }
  const now = Math.floor(Date.now() / 1000)
  const merged = {}
  const put = (d, t) => { if (d && (!merged[d] || merged[d] < t)) merged[d] = t }
  for (const x of macDirs.list) put(x.dir, x.t)
  for (const [d, t] of Object.entries(seenDirs)) put(d, t)
  for (const p of await listPanes()) put(p.dir, now + 1) // 当前开着的排最前
  return Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([dir, t]) => ({ dir, t }))
}

async function listPanes() {
  const raw = JSON.parse(await bridge('list'))
  const out = raw.map((p) => ({
    pane: p.pane_id,
    tab: p.tab_id,
    window: p.window_id,
    workspace: p.workspace,
    title: p.title,
    tabTitle: p.tab_title,
    cwd: (p.cwd || '').replace(/^file:\/\/[^/]*/, '').replace(/^\/Users\/[^/]+/, '~'),
    dir: decodeURIComponent((p.cwd || '').replace(/^file:\/\/[^/]*/, '')),
    cols: p.size?.cols,
    rows: p.size?.rows,
    active: p.is_active,
    cursor: { x: p.cursor_x, y: p.cursor_y, visible: p.cursor_visibility === 'Visible' },
  }))
  noteDirs(out)
  return out
}

// ---------- 画面同步 ----------
// 每个有人看的 pane 开一个常驻的 bridge watch（在电脑本机轮询，有变化才发一帧），
// 这里把每行处理成自带颜色状态的独立行，和上一帧逐行比较，只把变了的行推给手机。

const SGR_RE = /\x1b\[([0-9;:]*)m/g
// 每行开头补上前面几行遗留的样式，这样任何一行都能单独重画
function normalize(frame) {
  const raw = frame.replace(/\r/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').split('\n')
  let carry = []
  return raw.map((line) => {
    const prefix = carry.length ? `\x1b[${carry.join(';')}m` : ''
    for (const m of line.matchAll(SGR_RE)) {
      const p = m[1]
      if (p === '' || p === '0') carry = []
      else if (p.startsWith('0;')) carry = [p.slice(2)]
      else carry.push(p)
      if (carry.length > 12) carry = carry.slice(-12)
    }
    return prefix + line
  })
}

const watchers = new Map()
function startWatcher(pane) {
  const w = { pane, clients: new Set(), lines: null, seq: 0, proc: null, buf: '', size: null, stopped: false, restartTimer: null }
  const launch = () => {
    if (w.stopped) return
    const proc = bridgeProc(`watch ${pane} ${LINES}`, ['ignore', 'pipe', 'pipe'])
    w.proc = proc
    let err = ''
    proc.stderr.on('data', (d) => { err += d })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      w.buf += chunk.replace(/\x1f/g, '')
      let i
      while ((i = w.buf.indexOf('\x1d')) >= 0) {
        const frame = w.buf.slice(0, i)
        w.buf = w.buf.slice(i + 1)
        onFrame(w, frame)
      }
    })
    proc.on('close', () => {
      w.proc = null
      w.buf = ''
      if (w.stopped) return
      broadcast(w, 'fail', { message: err.trim().split('\n').pop() || '连接中断，重连中' })
      w.restartTimer = setTimeout(launch, 1500)
    })
  }
  launch()
  refreshSize(w)
  w.sizeTimer = setInterval(() => refreshSize(w), 4000)
  return w
}
function stopWatcher(w) {
  w.stopped = true
  clearTimeout(w.restartTimer)
  clearInterval(w.sizeTimer)
  w.proc?.kill()
  watchers.delete(w.pane)
}
async function refreshSize(w) {
  try {
    const p = (await listPanes()).find((x) => String(x.pane) === w.pane)
    if (!p) return broadcast(w, 'fail', { message: 'pane 已关闭' })
    const fg = (await bridge(`fg ${w.pane}`).catch(() => '')).trim()
    const size = { cols: p.cols, rows: p.rows, title: p.title, fg }
    if (!w.size || ['cols', 'rows', 'title', 'fg'].some((k) => w.size[k] !== size[k])) {
      w.size = size
      broadcast(w, 'size', size)
    }
  } catch {}
}
function onFrame(w, frame) {
  const lines = normalize(frame)
  const prev = w.lines
  w.lines = lines
  if (!prev) return pushFrame(w, 'full', { lines })
  const set = {}
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== prev[i]) { set[i] = lines[i]; n++ }
  }
  if (n === 0 && lines.length === prev.length) return
  // 变了一大半（比如滚动了一屏）就直接发全量
  if (n > lines.length * 0.6) return pushFrame(w, 'full', { lines })
  pushFrame(w, 'delta', { total: lines.length, set })
}
function watch(pane, res, since) {
  let w = watchers.get(pane)
  const c = { res, blocked: false, dirty: false }
  if (!w) {
    w = startWatcher(pane)
    watchers.set(pane, w)
  } else {
    if (w.size) send(res, 'size', w.size)
    // 手机手里的画面就是最新一帧（切后台再回来、网络抖一下）：不重发整屏
    if (w.lines) since === String(w.seq) ? send(res, 'resume', { seq: w.seq }, w.seq) : send(res, 'full', { lines: w.lines }, w.seq)
  }
  w.clients.add(c)
  clearTimeout(w.lingerTimer)
  lingering.delete(w)
  res.on('close', () => {
    w.clients.delete(c)
    if (w.clients.size === 0) linger(w)
  })
}
// 没人看了先别关：保留 45 秒，手机切回来直接接上（不用重新建通道、重新抓整屏）。
// 最多同时保留 3 个（relay 模式下免得占满电脑 sshd 的并发会话上限，默认 10）
const lingering = new Set()
function linger(w) {
  lingering.add(w)
  w.lingerTimer = setTimeout(() => { lingering.delete(w); if (w.clients.size === 0) stopWatcher(w) }, 45000)
  while (lingering.size > 3) {
    const oldest = lingering.values().next().value
    lingering.delete(oldest)
    clearTimeout(oldest.lingerTimer)
    if (oldest.clients.size === 0) stopWatcher(oldest)
  }
}
function send(res, event, data, id) {
  return res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}
// 背压：网络慢的手机写不进去时不再给它攒增量，等缓冲区排空后直接补一帧最新整屏（像 mosh 一样只同步最新状态）
function deliver(w, c, event, data, id) {
  if (c.blocked) { c.dirty = true; return }
  if (send(c.res, event, data, id)) return
  c.blocked = true
  c.res.once('drain', () => {
    c.blocked = false
    if (c.dirty && w.lines) { c.dirty = false; deliver(w, c, 'full', { lines: w.lines }, w.seq) }
  })
}
function pushFrame(w, event, data) {
  w.seq++
  for (const c of w.clients) deliver(w, c, event, data, w.seq)
}
function broadcast(w, event, data) {
  for (const c of w.clients) deliver(w, c, event, data)
}

// ---------- 手动重连 ----------
// 手机上点「重连」：自动重连之外的兜底。关掉这个 pane 的画面通道（在看的手机会自动连回来、拿到一个全新的通道），
// 清掉对话记录和定时任务缓存；relay 模式下电脑那边连不通时再把 ssh 共享连接整个重建
async function reconnect(pane) {
  const w = watchers.get(pane)
  if (w) {
    clearTimeout(w.lingerTimer)
    lingering.delete(w)
    stopWatcher(w)
    for (const c of w.clients) c.res.end()
  }
  transcripts.delete(pane)
  cronCache.delete(pane)
  let mac = 'ok'
  try {
    await Promise.race([bridge('list'), sleepMs(4000).then(() => { throw new Error('timeout') })])
  } catch (e) {
    mac = `reset (${e.message})`
    if (RELAY) await new Promise((r) => execFile('ssh', [...SSH_ARGS.slice(0, -1), '-O', 'exit', SSH_ARGS.at(-1)], { timeout: 5000 }, () => r()))
    try { await bridge('list'); mac += ' → ok' } catch (e2) { mac += ` → still failing: ${e2.message}` }
  }
  console.log(`reconnect pane ${pane}: watcher ${w ? 'restarted' : 'none'}, mac ${mac}`)
  return { ok: true, mac }
}

// ---------- pane 管理 ----------
// Claude 账号目录 → 启动命令（不同账号用不同的 wrapper，分叉时必须用同一个账号，不然找不到会话）
const CLAUDE_WRAPPERS = config.claudeWrappers
function agentCommand(info, mode) {
  const id = info.session
  switch (info.agent) {
    case 'claude': {
      const w = CLAUDE_WRAPPERS[path.basename(info.configDir || '')] || 'claude'
      return mode === 'fork' ? `${w} --resume ${id} --fork-session` : w
    }
    case 'codex': return mode === 'fork' ? `codex fork ${id}` : 'codex'
    case 'grok': return mode === 'fork' ? `grok --resume ${id} --fork-session` : 'grok'
    case 'cursor-agent': return mode === 'fork' ? '' : 'cursor-agent'
    default: return ''
  }
}
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
const isId = (v) => /^\d{1,6}$/.test(String(v))
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
async function manage(action, b) {
  if (action === 'spawn' || action === 'split') {
    if (typeof b.dir !== 'string' || !b.dir.startsWith('/') || b.dir.length > 1024) throw new Error('bad dir')
    let out
    if (action === 'spawn') {
      if (b.window !== 'new' && !isId(b.window)) throw new Error('bad window')
      out = await bridge(`spawn ${b.window} ${b64(b.dir)}`)
    } else {
      if (!isId(b.pane) || !['right', 'bottom', 'left', 'top'].includes(b.direction)) throw new Error('bad split')
      out = await bridge(`split ${b.pane} ${b.direction} ${b64(b.dir)}`)
    }
    const pane = out.trim()
    if (!isId(pane)) throw new Error(`unexpected: ${pane.slice(0, 80)}`)
    // 启动命令：等 shell 起来后像人一样敲进去（文字和回车分两次，跟手机发送一致）
    const cmd = typeof b.command === 'string' ? b.command.trim() : ''
    if (cmd) {
      if (cmd.length > 500 || /[\r\n]/.test(cmd)) throw new Error('bad command')
      await sleepMs(900)
      await bridge(`send ${pane} ${b64(cmd)}`)
      await sleepMs(60)
      await bridge(`send ${pane} ${b64('\r')}`)
    }
    return { pane: Number(pane) }
  }
  if (action === 'claude') {
    // 分叉当前会话（带着上下文开新会话）/ 同目录新开。各 agent 的命令不同；Claude 要用同一个账号的 wrapper 才找得到会话
    if (!isId(b.pane) || !['fork', 'new'].includes(b.mode) || !['right', 'bottom', 'tab'].includes(b.where)) throw new Error('bad request')
    const info = JSON.parse((await bridge(`session ${b.pane}`)) || '{}')
    if (!info.session && b.mode === 'fork') throw new Error('这个 pane 里还没找到会话')
    if (info.session && !/^[0-9a-zA-Z-]{8,64}$/.test(info.session)) throw new Error('bad session')
    const command = agentCommand(info, b.mode)
    if (!command) throw new Error(`${info.agent || '这个 agent'} 不支持分叉会话`)
    const pane = (await listPanes()).find((p) => String(p.pane) === String(b.pane))
    const dir = info.cwd || pane?.dir
    if (b.where === 'tab') return manage('spawn', { window: pane?.window ?? 'new', dir, command })
    return manage('split', { pane: b.pane, direction: b.where, dir, command })
  }
  if (!isId(b.pane)) throw new Error('bad pane')
  if (action === 'kill') { await bridge(`kill ${b.pane}`); return { ok: true } }
  if (action === 'focus') { await bridge(`focus ${b.pane}`); return { ok: true } }
  if (action === 'title') {
    const t = typeof b.title === 'string' ? b.title.trim() : ''
    if (t.length > 80 || /[\r\n]/.test(t)) throw new Error('bad title')
    await bridge(t ? `title ${b.pane} ${b64(t)}` : `title ${b.pane}`)
    return { ok: true }
  }
  throw new Error('unknown action')
}

// ---------- 对话记录缓存 ----------
// 每个 pane 记住上次的结果和记录文件标识（路径:大小）；1.5 秒内的重复请求直接回缓存，
// 之后只让电脑比一下文件大小，没变就不重新解析（会话记录动辄几十 MB）
const transcripts = new Map() // pane → { key, n, messages, at, pending }
async function transcript(pane, n) {
  const c = transcripts.get(pane)
  if (c && c.n >= n && Date.now() - c.at < 1500) return c.messages
  if (c?.pending) return c.pending
  const job = (async () => {
    const known = c && c.n >= n ? ` ${b64(c.key)}` : ''
    const d = JSON.parse((await bridge(`transcript ${pane} ${n}${known}`)) || '{}')
    if (d.unchanged && c) { c.at = Date.now(); return c.messages }
    const entry = { key: d.key || '', n, messages: d.messages || [], at: Date.now(), pending: null }
    transcripts.set(pane, entry)
    return entry.messages
  })()
  if (c) c.pending = job
  try { return await job } finally { if (c) c.pending = null }
}

// ---------- 定时任务 ----------
// Claude 会话里的定时任务要扫整个会话记录（可能上百 MB，约 0.4 秒），10 秒内的重复请求回缓存
const cronCache = new Map() // pane → { at, data, pending }
async function crons(pane, fresh) {
  const c = cronCache.get(pane)
  if (c?.pending) return c.pending
  if (c && !fresh && Date.now() - c.at < 10000) return c.data
  const job = bridge(`crons ${pane}`).then((o) => JSON.parse(o || '{}'))
  cronCache.set(pane, { at: c?.at || 0, data: c?.data, pending: job })
  try {
    const data = await job
    cronCache.set(pane, { at: Date.now(), data, pending: null })
    return data
  } catch (e) {
    cronCache.set(pane, { at: c?.at || 0, data: c?.data, pending: null })
    throw e
  }
}

// ---------- 上传 ----------
const UPLOAD_MAX = 25 << 20
function upload(req, name) {
  return new Promise((resolve, reject) => {
    const proc = bridgeProc(`put ${b64(name)}`, ['pipe', 'pipe', 'pipe'])
    let out = '', err = '', size = 0, done = false
    const finish = (fn, v) => { if (!done) { done = true; fn(v) } }
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { err += d })
    proc.on('close', (code) => code === 0 ? finish(resolve, out.trim()) : finish(reject, new Error((err.trim().split('\n').pop() || `exit ${code}`).replace(/^error: /, ''))))
    req.on('data', (c) => {
      size += c.length
      if (size > UPLOAD_MAX) { finish(reject, new Error('文件超过 25MB')); proc.kill(); req.destroy() }
    })
    req.pipe(proc.stdin)
  })
}

// ---------- 手机在看时别让电脑睡着 ----------
let lastApi = 0
// 同时告诉电脑「手机在用」：电脑上要打开网址时（pane-open），据此改在手机的预览面板里打开
// 有手机正连着的画面流（保留中、没人看的不算）
const viewing = () => [...watchers.values()].some((w) => w.clients.size > 0)
function phoneInUse() { return viewing() || !!previews.chrome.client || !!previews.cursor.client || Date.now() - lastApi < 120000 }
setInterval(() => {
  if (phoneInUse()) bridge('awake').catch((e) => console.log(`awake: ${e.message}`))
}, 60000)

// ---------- 预览 ----------
// 每个来源一个 preview 代理（ssh 常驻）：chrome = 电脑上自己的无界面 Chrome；cursor = 接管 Cursor IDE 的内置浏览器。
// 同一来源同一时间只服务一个手机连接，新连接顶掉旧的。手机断开 60 秒后关掉代理（停推流）；
// chrome 来源 20 分钟没人用再把预览用的 Chrome 关掉省内存（cursor 来源不关任何东西，那是用户自己的 Cursor）。
const PREVIEW_IN = new Set(['refresh', 'open', 'viewport', 'tap', 'hover', 'scroll', 'text', 'key', 'back', 'forward', 'reload', 'ack', 'tabs', 'switch', 'close', 'new'])
function makePreview(source, command) {
  const pv = { source, proc: null, client: null, buf: '', idleTimer: null, gcTimer: null, last: {} }
  pv.start = () => {
    if (pv.proc) return
    const proc = bridgeProc(command, ['pipe', 'pipe', 'pipe'])
    pv.proc = proc
    pv.buf = ''
    let err = ''
    proc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000) })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      pv.buf += chunk
      let i
      while ((i = pv.buf.indexOf('\n')) >= 0) {
        const line = pv.buf.slice(0, i)
        pv.buf = pv.buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        const c = pv.client
        if (m.t === 'frame') {
          if (c?.readyState === 1) {
            c.send(JSON.stringify({ t: 'frame', seq: m.seq, w: m.w, h: m.h, desktop: !!m.desktop }))
            c.send(Buffer.from(m.data, 'base64'))
          } else proc.stdin.write(JSON.stringify({ t: 'ack', seq: m.seq }) + '\n') // 没人看也要 ack，免得卡住
          continue
        }
        if (m.t === 'nav' || m.t === 'tabs') pv.last[m.t] = m // 新连上的手机先拿到当前地址和标签页
        if (c?.readyState === 1) c.send(line)
      }
    })
    proc.on('close', (code) => {
      if (pv.proc === proc) pv.proc = null
      const msg = err.trim().split('\n').filter((l) => !l.startsWith('[preview]')).pop()
      if (pv.client?.readyState === 1) pv.client.send(JSON.stringify({ t: 'closed', msg: code ? msg || `预览代理退出（${code}）` : '' }))
    })
  }
  pv.send = (m) => { if (pv.proc) pv.proc.stdin.write(JSON.stringify(m) + '\n') }
  pv.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 << 10 })
  pv.wss.on('connection', (ws) => {
    clearTimeout(pv.idleTimer)
    clearTimeout(pv.gcTimer)
    if (pv.client && pv.client !== ws) { try { pv.client.close(4000, '另一台设备打开了预览') } catch {} }
    pv.client = ws
    pv.start()
    for (const m of Object.values(pv.last)) ws.send(JSON.stringify(m))
    pv.send({ t: 'refresh' }) // 上一个手机可能有一帧没 ack 就断了：让代理马上补一帧给新手机
    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let m
      try { m = JSON.parse(String(data)) } catch { return }
      if (!PREVIEW_IN.has(m?.t)) return
      lastApi = Date.now()
      pv.send(m)
    })
    ws.on('close', () => {
      if (pv.client !== ws) return
      pv.client = null
      pv.idleTimer = setTimeout(() => { pv.proc?.stdin.end(); pv.last = {} }, 60000)
      if (source === 'chrome') pv.gcTimer = setTimeout(() => bridge('preview-stop').then((o) => console.log(`preview gc: ${o.trim()}`), () => {}), 20 * 60000)
    })
  })
  return pv
}
const previews = { chrome: makePreview('chrome', 'preview'), cursor: makePreview('cursor', 'preview-cursor') }
const preview = previews.chrome
const previewSend = preview.send

const gzCache = new Map()
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 64 << 10) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 身份校验：tailscale serve 会把访问者的 Tailscale 登录名放进 Tailscale-User-Login（访问者带不进这个头，serve 会覆盖）。
// local 模式下服务和别的程序在同一台电脑上，再校验 Host 必须是 tailscale serve 的主机名：
// 挡住电脑上浏览器里的网页借 localhost / DNS 重绑定来调接口（这类请求的 Host 不会是 xxx.ts.net）
const SERVE_HOSTS = new Set(config.serveHosts.map((h) => h.toLowerCase()))
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin) { try { return new URL(origin).host === req.headers.host } catch { return false } }
  return req.headers['sec-fetch-site'] === 'same-origin'
}
function authorized(req) {
  const login = req.headers['tailscale-user-login']
  if (!login || !ALLOWED.has(login)) return false
  if (RELAY) return true
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  return SERVE_HOSTS.has(host)
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('forbidden')
  }
  const url = new URL(req.url, 'http://x')
  if (url.pathname.includes('/api/')) lastApi = Date.now()
  // 所有会改东西的请求（非 GET）都必须来自本站页面：挡住别的网页借浏览器里的登录身份发表单 / 跨站请求
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'bad origin' })
  try {
    // Cursor 模块（可选，pane-remote enable cursor）：映射 Cursor IDE 的会话
    if (url.pathname.startsWith('/api/cursor/')) {
      if (url.pathname === '/api/cursor/summary') return json(res, 200, config.modules.cursor ? cursorSummary() : { conn: 'disabled', waiting: [], unread: 0 })
      if (!config.modules.cursor) return json(res, 404, { error: 'Cursor 模块没开（pane-remote enable cursor）' })
      if (url.pathname === '/api/cursor/stream' && req.method === 'GET') return cursorStream(req, res, url)
      if (url.pathname === '/api/cursor/cmd' && req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
        return json(res, 200, await cursorCmd(JSON.parse((await readBody(req, 64 << 10)) || '{}')))
      }
    }
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, { presets: config.presets, modules: config.modules })
    }
    if (url.pathname === '/api/panes' && req.method === 'GET') {
      return json(res, 200, await listPanes())
    }
    if (url.pathname === '/api/stream' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!/^\d{1,6}$/.test(pane || '')) return json(res, 400, { error: 'bad pane' })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      // 重连间隔带点随机，几台设备不会同时砸过来
      res.write(`retry: ${1500 + Math.floor(Math.random() * 1500)}\n\n`)
      // 具名 ping 事件：前端据此判断连接是不是假死（注释行 JS 收不到）
      const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000)
      res.on('close', () => clearInterval(ping))
      return watch(pane, res, url.searchParams.get('since') || req.headers['last-event-id'] || null)
    }
    if (url.pathname === '/api/send' && req.method === 'POST') {
      // 只接受同源 JSON，挡住跨站表单
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'bad origin' })
      const { pane, data } = JSON.parse(await readBody(req))
      if (!/^\d{1,6}$/.test(String(pane)) || typeof data !== 'string' || !data) return json(res, 400, { error: 'bad request' })
      await bridge(`send ${pane} ${Buffer.from(data, 'utf8').toString('base64')}`)
      if (/\r|^[0-9yn]$/.test(data)) push.markInput(pane) // 回车或回答提示：清掉「已完成」
      return json(res, 200, { ok: true })
    }
    if (url.pathname.startsWith('/api/pane/') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const origin = req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'bad origin' })
      const b = JSON.parse((await readBody(req, 16 << 10)) || '{}')
      return json(res, 200, await manage(url.pathname.slice('/api/pane/'.length), b))
    }
    if (url.pathname === '/api/claude' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!/^\d{1,6}$/.test(pane || '')) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, JSON.parse((await bridge(`session ${pane}`)) || '{}'))
    }
    if (url.pathname === '/api/transcript' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      const n = Math.min(200, Number(url.searchParams.get('n')) || 60)
      if (!/^\d{1,6}$/.test(pane || '')) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, await transcript(pane, n))
    }
    if (url.pathname === '/api/reconnect' && req.method === 'POST') {
      const { pane } = JSON.parse((await readBody(req, 1024)) || '{}')
      if (!/^\d{1,6}$/.test(String(pane))) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, await reconnect(String(pane)))
    }
    if (url.pathname === '/api/crons' && req.method === 'GET') {
      const pane = url.searchParams.get('pane')
      if (!/^\d{1,6}$/.test(pane || '')) return json(res, 400, { error: 'bad pane' })
      return json(res, 200, await crons(pane, url.searchParams.has('fresh')))
    }
    if (url.pathname === '/api/ls' && req.method === 'GET') {
      const p = (url.searchParams.get('path') || '').slice(0, 1000)
      if (!/^[~/]/.test(p)) return json(res, 400, { error: 'bad path' })
      return json(res, 200, JSON.parse((await bridge(`ls ${b64(p)}`)) || '[]'))
    }
    if (url.pathname === '/api/dirs' && req.method === 'GET') return json(res, 200, await allDirs())
    if (url.pathname === '/api/states' && req.method === 'GET') {
      return json(res, 200, push.states())
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || 'file').slice(0, 200)
      return json(res, 200, { path: await upload(req, name) })
    }
    if (url.pathname === '/api/push/prefs' && req.method === 'GET') return json(res, 200, push.getPrefs())
    if (url.pathname === '/api/push/key' && req.method === 'GET') {
      return json(res, 200, { key: push.publicKey })
    }
    if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' })
      const body = JSON.parse((await readBody(req, 16 << 10)) || '{}')
      const action = url.pathname.slice('/api/push/'.length)
      if (action === 'subscribe') { push.subscribe(body.subscription); return json(res, 200, { ok: true }) }
      if (action === 'unsubscribe') { push.unsubscribe(body.endpoint); return json(res, 200, { ok: true }) }
      if (action === 'status') return json(res, 200, { subscribed: push.hasSub(body.endpoint) })
      if (action === 'prefs') return json(res, 200, push.setPrefs(body))
      if (action === 'test') return json(res, 200, await push.notify({ title: 'Pane Remote', body: '测试通知：能看到这条说明推送通了', tag: 'test' }))
      return json(res, 404, { error: 'not found' })
    }
    if (url.pathname === '/api/log' && req.method === 'POST') {
      // 手机端把报错发回来，记进服务日志
      const body = (await readBody(req, 16 << 10)).slice(0, 4000)
      console.log(`[client] ${req.headers['user-agent'] || ''} ${body.replace(/\s+/g, ' ')}`)
      return json(res, 200, { ok: true })
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method' })
    const root = PUBLIC
    let rel = url.pathname
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
    // 手机缓存里的旧首页可能引用已经不在的旧构建（index-xxxx.js / .css）：给它最新的同类文件，不然整页白屏
    if (file.startsWith(root) && !fs.existsSync(file) && /[/\\]assets[/\\]index-[\w-]+\.(js|css)$/.test(file)) {
      const ext = path.extname(file)
      const dir = path.dirname(file)
      const latest = fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith(ext))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
      if (latest) { console.log(`asset fallback ${path.basename(file)} → ${latest.f}`); file = path.join(dir, latest.f) }
    }
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' })
    // 带 Content-Length 和 ETag，一律 no-cache（每次向服务端确认，没变就 304）。
    // 以前 assets 用 immutable 且没有 Content-Length：iPhone 唤醒时下载中断，Safari 把半截脚本当成完整文件缓存一年，
    // 之后每次打开都用坏文件，清 SW 缓存也没用（那是浏览器的 HTTP 缓存），表现为部署后白屏、怎么重载都白屏
    const st = fs.statSync(file)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end() }
    const type = TYPES[path.extname(file)] || 'application/octet-stream'
    // 文本类文件 gzip 后再发（800KB 的脚本压到 230KB 左右，手机唤醒时下载被打断的机会小很多），压缩结果按 ETag 缓存
    if (/^(text\/|application\/(json|manifest))/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024) {
      let gz = gzCache.get(file)
      if (!gz || gz.etag !== etag) { gz = { etag, buf: zlib.gzipSync(fs.readFileSync(file), { level: 9 }) }; gzCache.set(file, gz) }
      res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': gz.buf.length, vary: 'accept-encoding', etag, 'cache-control': 'no-cache' })
      return res.end(gz.buf)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, etag, 'cache-control': 'no-cache' })
    fs.createReadStream(file).pipe(res)
  } catch (e) {
    json(res, 502, { error: e.message })
  }
})

// 电脑上要打开网址（pane-open 写的 open 事件）：预览开着就直接打开并提示；否则发给正在看终端的手机，再推一条通知
function onOpen(url) {
  if (!/^(https?|file):\/\//.test(url)) return
  if (preview.client?.readyState === 1) {
    previewSend({ t: 'open', url })
    preview.client.send(JSON.stringify({ t: 'opened', url }))
    return
  }
  // 手机正开着终端页：页面里弹提示就够了，不再推通知
  if (viewing()) { for (const w of watchers.values()) broadcast(w, 'openurl', { url }); return }
  push.notify({ title: '电脑要打开一个网页', body: url.slice(0, 200), tag: 'open-url', url })
    .then((r) => console.log(`notify(open) ${url} → ${JSON.stringify(r)}`))
}

// Cursor 模块：电脑上常驻一个 cursor-agent；做完 / 在等你时推送（遵守「一轮做完也推」开关，人在电脑前不推）
if (config.modules.cursor) initCursor({
  dataDir: config.dataDir,
  spawnBridge: (cmd) => bridgeProc(cmd, ['pipe', 'pipe', 'pipe']),
  notify: (p) => {
    if (p.kind === 'stop' && !push.getPrefs().stop) return
    if (push.macIdle() < 120) return
    push.notify({ title: p.title, body: p.body, tag: p.tag, cursor: p.cursor }).then((r) => console.log(`notify(cursor) ${p.title} → ${JSON.stringify(r)}`))
  },
})

push.startMonitor({
  onOpen,
  bridge,
  isWatching: (pane) => (watchers.get(String(pane))?.clients.size || 0) > 0,
  active: () => viewing() || Date.now() - lastApi < 120000,
})

// WebSocket 升级不经过上面的请求处理，身份和来源要在这里单独查
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  const origin = req.headers.origin
  const okPath = url.pathname === '/api/preview' && (url.searchParams.get('source') === 'cursor' ? !!config.modules.cursor : config.modules.preview)
  if (!authorized(req) || !okPath || (origin && new URL(origin).host !== req.headers.host)) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const pv = url.searchParams.get('source') === 'cursor' ? previews.cursor : previews.chrome
  pv.wss.handleUpgrade(req, socket, head, (ws) => pv.wss.emit('connection', ws, req))
})

if (!ALLOWED.size) console.log('警告：allowedLogins 是空的，所有请求都会被拒绝（跑 pane-remote init 配置）')
if (!RELAY && !SERVE_HOSTS.size) console.log('警告：serveHosts 是空的，local 模式下所有请求都会被拒绝（跑 pane-remote init 配置）')
server.listen(PORT, '127.0.0.1', () => console.log(`pane-remote (${config.mode}) on 127.0.0.1:${PORT}, ${ALLOWED.size} allowed login(s)`))
