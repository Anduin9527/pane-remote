// 插件工具的无界面运行时（子进程，由 tools.mjs 用 fork 起）：agent 经 MCP 调插件工具时，在这里跑插件的 preload，
// 收集 utools.registerTool 注册的函数，再按调用执行。对应 uTools「工具被调用时插件没在运行，就启动插件、初始化工具执行环境」。
// 隔离：
//   - 进程带 --permission 起，只许读这个文件本身：不能读写文件、起子进程、开 worker；环境变量是空的（拿不到服务端的密钥）
//   - 插件代码在 vm 的新上下文里跑，只给下面这些全局量；vm 不算安全边界，上面的进程权限才是
//   - 能做的事只有：网络（fetch，同插件页）、经 IPC 请服务端做插件本来就能做的平台调用（照样查权限、记审计）
// 数据库：和插件页一样是本地副本（启动时带全部文档），写入攒一下推给服务端；别处（手机上的插件页）的改动由服务端推过来。
// 工具返回之前先把写入推完，agent 拿到结果时数据已经落盘、手机上也看得到了。
// 这个文件不能 import 仓库里别的文件（--allow-fs-read 只放行了它自己）。
import vm from 'node:vm'

const STORAGE_PREFIX = '\u0000storage/'
const send = (m) => { try { process.send(m) } catch {} } // ignore: 父进程走了，下面 disconnect 会退出
process.on('disconnect', () => process.exit(0))

let seq = 0
const waiting = new Map() // id → { resolve, reject }
function request(t, body) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    send({ t, id, ...body })
  })
}
const callPlatform = (method, args) => request('call', { method, args: args ?? {} })

// ---------- 数据库副本（规则同 platform/runtime.js） ----------
let docs = {}, tombs = {}
const pullFns = []
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const revN = (rev) => (rev ? Number(String(rev).split('-')[0]) || 0 : 0)
const revWins = (a, b) => { const na = revN(a), nb = revN(b); return na !== nb ? na > nb : a > b }
const nextRev = (prev) => `${revN(prev) + 1}-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16)}`
const dbErr = (id, name, message) => ({ id, error: true, name, message })
let outbox = new Map(), flushTimer = null, flushing = Promise.resolve()
function queue(doc) {
  outbox.set(doc._id, doc)
  if (!flushTimer) flushTimer = setTimeout(flush, 50)
}
function flush() {
  clearTimeout(flushTimer)
  flushTimer = null
  if (!outbox.size) return flushing
  const list = [...outbox.values()]
  outbox = new Map()
  flushing = flushing.then(() => request('db.push', { docs: list })).catch((e) => {
    for (const d of list) if (!outbox.has(d._id)) outbox.set(d._id, d)
    console.warn(`数据没存上，稍后重试：${e.message}`)
    if (!flushTimer) flushTimer = setTimeout(flush, 3000)
  })
  return flushing
}
function putOne(input) {
  if (!input || typeof input !== 'object' || typeof input._id !== 'string' || !input._id) return dbErr(String(input?._id || ''), 'bad_request', 'doc._id must be a non-empty string')
  const id = input._id, cur = docs[id]
  if (cur && cur._rev !== input._rev) return dbErr(id, 'conflict', 'Document update conflict')
  if (!cur && input._rev && !input._deleted && input._rev !== tombs[id]) return dbErr(id, 'conflict', 'Document update conflict')
  if (input._deleted) {
    if (!cur) return dbErr(id, 'not_found', 'missing')
    const rev = nextRev(cur._rev)
    delete docs[id]
    tombs[id] = rev
    queue({ _id: id, _rev: rev, _deleted: true })
    return { id, ok: true, rev }
  }
  let body
  try { body = JSON.stringify(input) } catch (e) { return dbErr(id, 'bad_request', `doc is not serializable: ${e.message}`) }
  if (body.length > 1024 * 1024) return dbErr(id, 'exception', 'doc size exceeds 1M')
  const doc = JSON.parse(body)
  doc._rev = nextRev(cur ? cur._rev : tombs[id])
  docs[id] = doc
  delete tombs[id]
  queue(doc)
  return { id, ok: true, rev: doc._rev }
}
/** 别处的改动：rev 赢了才收（和服务端的 DocDb.applyRemote 同一个规则） */
function applyRemote(list) {
  const applied = []
  for (const d of list || []) {
    if (!d?._id || !d._rev) continue
    const cur = docs[d._id]?._rev ?? tombs[d._id]
    if (cur && !revWins(d._rev, cur)) continue
    if (d._deleted) { delete docs[d._id]; tombs[d._id] = d._rev } else { docs[d._id] = clone(d); delete tombs[d._id] }
    applied.push(clone(d))
  }
  if (applied.length) for (const fn of pullFns) { try { fn(clone(applied)) } catch (e) { console.error(e) } }
}
const db = {
  put: (d) => putOne(d),
  get: (id) => (docs[id] ? clone(docs[id]) : null),
  remove(docOrId) {
    const id = typeof docOrId === 'string' ? docOrId : docOrId?._id
    const cur = docs[id]
    if (!cur) return dbErr(String(id), 'not_found', 'missing')
    if (typeof docOrId !== 'string' && docOrId._rev !== undefined && docOrId._rev !== cur._rev) return dbErr(id, 'conflict', 'Document update conflict')
    return putOne({ ...clone(cur), _deleted: true })
  },
  bulkDocs: (list) => (Array.isArray(list) ? list.map(putOne) : [dbErr('', 'bad_request', 'docs must be an array')]),
  allDocs(filter) {
    let list
    if (Array.isArray(filter)) list = filter.map((id) => docs[id]).filter(Boolean)
    else { const prefix = typeof filter === 'string' ? filter : ''; list = Object.keys(docs).filter((id) => !id.startsWith(STORAGE_PREFIX) && id.startsWith(prefix)).map((id) => docs[id]) }
    return clone(list.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0)))
  },
  postAttachment: () => dbErr('', 'not_supported', '工具运行时不支持附件'),
  getAttachment: () => null,
  getAttachmentType: () => null,
}
db.promises = Object.fromEntries(['put', 'get', 'remove', 'bulkDocs', 'allDocs', 'postAttachment', 'getAttachment', 'getAttachmentType'].map((k) => [k, async (...a) => db[k](...a)]))
const dbStorage = {
  setItem(key, value) { const id = STORAGE_PREFIX + String(key), cur = docs[id]; putOne({ _id: id, _rev: cur ? cur._rev : tombs[id], value: value === undefined ? null : clone(value) }) },
  getItem(key) { const d = docs[STORAGE_PREFIX + String(key)]; return d ? (d.value == null ? null : clone(d.value)) : null },
  removeItem(key) { const d = docs[STORAGE_PREFIX + String(key)]; if (d) db.remove(d) },
}

// ---------- 插件看到的 API ----------
const tools = new Map()
const unsupported = (name) => () => { throw Object.assign(new Error(`[pane-remote] 工具运行时里不支持 ${name}（这里没有界面）`), { code: 'EWTUNSUPPORTED' }) }
function buildApi(boot) {
  const P = boot.plugin
  const platform = {
    info: () => ({ ...boot.platform, plugin: P.id, headless: true }),
    call: callPlatform,
    incident: { report: (o) => callPlatform('platform.incident.report', o || {}) },
    storage: {
      get: (group, key) => callPlatform('platform.storage.get', { group, key }),
      set: (group, key, value) => callPlatform('platform.storage.set', { group, key, value }),
      remove: (group, key) => callPlatform('platform.storage.remove', { group, key }),
      keys: (group) => callPlatform('platform.storage.keys', { group }),
    },
    sessions: {
      list: () => callPlatform('platform.sessions.list', {}),
      send: (o) => callPlatform('platform.sessions.send', o || {}),
      note: (o) => callPlatform('platform.sessions.note', o || {}),
    },
    agent: {
      ask: (o) => callPlatform('platform.agent.ask', o || {}),
      notify: (o) => callPlatform('platform.agent.notify', o || {}),
    },
  }
  const register = (name, handler) => { if (typeof handler === 'function') tools.set(String(name), handler) }
  const notify = (body, title) => { callPlatform('system.notify', { body: String(body ?? ''), title: typeof title === 'string' ? title : '' }).catch((e) => console.warn(e.message)) }
  const wt = {
    identity: { platform: boot.platform, plugin: { id: P.id, name: P.name, version: P.version } },
    supports: (name) => (['tools.register', 'registerTool', 'db.put', 'db.get', 'db.remove', 'db.bulk', 'db.all', 'kv.set', 'kv.get', 'kv.remove', 'db.onPull', 'onDbPull', 'system.notify', 'showNotification'].includes(name) ? 'emulated' : false),
    lifecycle: { onEnter() {}, onLeave() {}, onReady(fn) { setTimeout(fn) }, exit() {} },
    window: { type: 'headless' },
    db: { put: db.put, get: db.get, remove: db.remove, bulk: db.bulkDocs, all: db.allDocs, onPull: (fn) => { if (typeof fn === 'function') pullFns.push(fn) }, promises: db.promises },
    kv: { set: dbStorage.setItem, get: dbStorage.getItem, remove: (k) => { const had = dbStorage.getItem(k) !== null; dbStorage.removeItem(k); return had } },
    tools: { register },
    system: { notify, appName: () => 'pane-remote', appVersion: () => boot.platform.version, isDev: () => false, isMac: () => false, isWindows: () => false, isLinux: () => false, isDark: () => false, onThemeChange() {} },
    features: { list: () => clone(P.features || []) },
    platform,
  }
  const utools = {
    db: { ...db, promises: { ...db.promises } },
    dbStorage,
    registerTool: register,
    onDbPull: wt.db.onPull,
    onPluginEnter() {}, onPluginOut() {}, onPluginReady(fn) { setTimeout(fn) }, onPluginDetach() {},
    showNotification: (body) => notify(body),
    getAppName: () => 'pane-remote', getAppVersion: () => boot.platform.version,
    isDev: () => false, isMacOS: () => false, isWindows: () => false, isLinux: () => false, isDarkColors: () => false,
    getFeatures: () => clone(P.features || []),
    getWindowType: () => 'headless',
    outPlugin() {}, hideMainWindow() {}, showMainWindow() {}, setExpandHeight() {}, setSubInput() {}, removeSubInput() {},
  }
  for (const n of ['copyText', 'shellOpenExternal', 'shellOpenPath', 'redirect', 'createBrowserWindow', 'screenCapture', 'ubrowser']) utools[n] = unsupported(n)
  return { wt, utools }
}

// ---------- 启动 ----------
let ready = false
process.on('message', async (m) => {
  if (!m || typeof m !== 'object') return
  if (m.t === 'reply') {
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id)
    return m.ok ? w.resolve(m.value) : w.reject(Object.assign(new Error(m.error?.message || 'error'), { code: m.error?.code }))
  }
  if (m.t === 'db') return applyRemote(m.docs)
  if (m.t === 'init' && !ready) {
    ready = true
    for (const d of m.boot.docs || []) { if (d._deleted) tombs[d._id] = d._rev; else docs[d._id] = d }
    const { wt, utools } = buildApi(m.boot)
    const sandbox = {
      console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone,
      fetch, Headers, Request, Response, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, Blob, atob, btoa,
      crypto: globalThis.crypto,
      utools, whatevertools: wt,
      module: { exports: {} },
      require: (name) => { throw Object.assign(new Error(`[pane-remote] 工具运行时里没有 Node.js 模块（require('${name}')）`), { code: 'EWTUNSUPPORTED' }) },
    }
    sandbox.exports = sandbox.module.exports
    sandbox.window = sandbox
    sandbox.self = sandbox
    sandbox.globalThis = sandbox
    try {
      vm.runInNewContext(m.code, sandbox, { filename: m.filename, timeout: 5000 })
      // preload 里 onPluginReady / 异步注册的：给一拍时间
      await new Promise((r) => setTimeout(r, 20))
      send({ t: 'ready', tools: [...tools.keys()] })
    } catch (e) {
      send({ t: 'ready', error: `${e.name || 'Error'}: ${e.message}`, stack: String(e.stack || '').slice(0, 4000) })
    }
    return
  }
  if (m.t === 'run') {
    const fn = tools.get(m.tool)
    try {
      if (!fn) throw Object.assign(new Error(`插件没有注册工具 ${m.tool}（preload 里要 utools.registerTool('${m.tool}', …)）`), { code: 'ENOTOOL' })
      const ctx = { requestId: m.requestId, caller: m.caller || null, sendProgress: (p) => send({ t: 'progress', id: m.id, progress: p }) }
      const value = await fn(m.args || {}, ctx)
      await flush()
      send({ t: 'result', id: m.id, ok: true, value: value === undefined ? null : clone(value) })
    } catch (e) {
      await flush().catch(() => {}) // ignore: 出错时也尽量把已经写的推上去
      send({ t: 'result', id: m.id, ok: false, error: { message: String(e?.message || e).slice(0, 4000), code: e?.code || 'ETOOL', stack: String(e?.stack || '').slice(0, 4000) } })
    }
  }
})
process.on('uncaughtException', (e) => send({ t: 'error', msg: `${e.name}: ${e.message}`, stack: String(e.stack || '').slice(0, 4000) }))
process.on('unhandledRejection', (e) => send({ t: 'error', msg: `unhandled rejection: ${e?.message || e}`, stack: String(e?.stack || '').slice(0, 4000) }))
send({ t: 'hello' })
