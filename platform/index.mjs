// 插件平台 core（服务端侧）。server.mjs 启动时 createPlatform(...)，把 /api/plugins*、/plugins/* 和 WS /api/platform/ws 交给这里。
//   GET  /api/plugins                    插件列表（描述 + 预先算好拼音的功能指令）
//   GET  /api/plugins/support            support 表：whatevertools 每个 API 在 pane-remote 上的支持程度和实现方
//   GET  /api/plugins/permissions?plugin=  这个插件的权限结论；POST {plugin, permission, decision: grant|deny|ask} 或 {plugin, reset: true}
//   GET  /api/plugins/audit[?plugin=]    最近的能力调用审计
//   GET  /api/plugins/asks               插件在手机上问的、还没答的问题（WS 断着时的兜底）
//   GET  /api/plugins/fs-dirs?plugin=    用户允许这个插件读的 Mac 目录；POST {plugin, dirs: [...]} 整个替换（私有目录总是可读，不在这里）
//   GET  /plugins/_runtime.js            注入插件页的运行时（window.whatevertools / window.utools 子集）
//   GET  /plugins/<id>/<文件>            插件静态文件：单独子路径，带 CSP（sandbox、不许被别的站嵌）；HTML 里注入运行时和启动数据
//   WS   /api/platform/ws?client=<id>    前端和平台之间的 RPC：call / result、权限询问 prompt、问题 asks；
//                                        流式调用（call 带 stream: true）：chunk 片段、tool 回调插件页的工具（前端回 tool-result）、cancel 取消
// 插件 iframe 没有 allow-same-origin：它的 fetch 带 Origin: null，server.mjs 对这种请求一律拒绝，插件只能经前端的 postMessage 调平台。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DocDb } from '@whatevertools/core'
import { FileBackend } from '@whatevertools/db-file'
import { createCatalog } from './catalog.mjs'
import { createPermissions } from './permissions.mjs'
import { createAudit } from './audit.mjs'
import { createRpc, createShared, createAsks, supportTable, runtimeTable, cleanDir, PLATFORM, PLUGIN_API, PRIVATE_DIR } from './rpc.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME = path.join(HERE, 'runtime.js')
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav',
}
const PROMPT_TIMEOUT = 5 * 60000
const CLIENT_GC = 10 * 60000
const isTestHost = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(host || ''))

/** 插件页的 CSP：和 iframe 的 sandbox 一致（即使有人直接打开这个地址也是沙盒），只许本站嵌入；页面里的 fetch 可以访问外网（同 whatevertools：network 权限只管 Node 模块） */
function csp(rawHost) {
  const host = /^[\w.-]+(:\d+)?$|^\[[\d:a-f]+\](:\d+)?$/i.test(String(rawHost || '')) ? rawHost : 'invalid.invalid' // Host 头不规整就不放进 CSP
  const self = `'self' http://${host} https://${host}`
  return [
    'sandbox allow-scripts allow-forms',
    `default-src ${self} data: blob:`,
    `script-src ${self} 'unsafe-inline' 'unsafe-eval' blob:`,
    `style-src ${self} 'unsafe-inline' https:`,
    `img-src ${self} data: blob: https:`,
    `font-src ${self} data: https:`,
    `media-src ${self} data: blob: https:`,
    `connect-src ${self} https: wss:`,
    `worker-src ${self} blob:`,
    "frame-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
    `base-uri ${self}`,
  ].join('; ')
}

/**
 * deps: { dataDir, pluginsDir, WebSocketServer, notify(payload), recordIncident(r), host? }
 *   host：服务端到电脑上 pane-host 的 HostClient（AI、电脑剪贴板、打开网址、只读文件走它；不给就是这些能力都不在线）
 */
export function createPlatform(deps) {
  const root = path.join(deps.dataDir, 'plugins')
  const VERSION = deps.version || '0.0.0' // 系统版本（根目录 package.json）
  const catalog = createCatalog(deps.pluginsDir, { apiVersion: PLUGIN_API })
  const perms = createPermissions({ file: path.join(root, 'permissions.json') })
  const audit = createAudit(path.join(root, 'audit.jsonl'))
  const dbs = new Map()
  async function dbFor(m) {
    let db = dbs.get(m.id)
    if (!db) {
      db = new DocDb(new FileBackend({ dir: path.join(root, 'db', m.id) }))
      db.onWriteError = (e) => console.error(`plugins: db write ${m.id} ${e.message}`, e)
      dbs.set(m.id, db)
    }
    await db.load()
    return db
  }
  const sharedDir = path.join(root, 'shared')
  const shared = createShared({
    read: (g) => { try { return JSON.parse(fs.readFileSync(path.join(sharedDir, `${g}.json`), 'utf8')) } catch { return null } },
    write: (g, data) => {
      fs.mkdirSync(sharedDir, { recursive: true })
      const f = path.join(sharedDir, `${g}.json`)
      fs.writeFileSync(f + '.tmp', JSON.stringify(data), { mode: 0o600 })
      fs.renameSync(f + '.tmp', f)
    },
  })

  // ---------- 前端连接 ----------
  // client id 由前端每次打开页面生成；断线重连带同一个 id，断开期间的结果、询问先排队，连上再补发
  const clients = new Map() // id → { id, ws, queue, visible, test, seen, running }
  const open = (c) => c.ws?.readyState === 1
  function send(c, msg) {
    if (open(c)) c.ws.send(JSON.stringify(msg))
    else { c.queue.push(msg); if (c.queue.length > 200) c.queue.shift() }
  }
  const broadcast = (msg) => { for (const c of clients.values()) if (open(c)) c.ws.send(JSON.stringify(msg)) }
  const hasVisibleClient = () => [...clients.values()].some((c) => open(c) && c.visible && !c.test)
  // 断开太久的连接：清掉，还在跑的流式调用（AI）一起取消
  setInterval(() => { const old = Date.now() - CLIENT_GC; for (const [id, c] of clients) if (!open(c) && c.seen < old) { for (const r of c.running.values()) r.ac.abort(); clients.delete(id) } }, 60000).unref()

  const asks = createAsks({ notify: deps.notify, broadcast, hasVisibleClient })

  // 用户允许插件读的 Mac 目录（插件权限设置里加）：{ 插件 id: ['~/Documents/x', …] }
  const fsDirsFile = path.join(root, 'fs-dirs.json')
  let fsDirsData = (() => { try { return JSON.parse(fs.readFileSync(fsDirsFile, 'utf8')) } catch { return {} } })()
  const fsDirs = {
    get: (id) => (Array.isArray(fsDirsData[id]) ? fsDirsData[id] : []),
    set(id, dirs) {
      const list = [...new Set((Array.isArray(dirs) ? dirs : []).map(cleanDir))].slice(0, 20)
      fsDirsData = { ...fsDirsData, [id]: list }
      if (!list.length) delete fsDirsData[id]
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(fsDirsFile + '.tmp', JSON.stringify(fsDirsData), { mode: 0o600 })
      fs.renameSync(fsDirsFile + '.tmp', fsDirsFile)
      return list
    },
  }
  // Mac 的家目录（插件给绝对路径时换成 ~/… 再找根目录）：pane-host 的 ping 里有，连上一次记下来
  let macHome = ''
  deps.host?.on?.('up', (r) => { if (r?.home) macHome = r.home })
  const home = async () => {
    // ignore: ping 失败就当不知道家目录，绝对路径只能原样匹配
    if (!macHome && deps.host?.connected) macHome = (await deps.host.call('ping').catch(() => null))?.home || ''
    return macHome
  }
  const rpc = createRpc({ catalog, perms, audit, dbFor, shared, asks, notify: deps.notify, recordIncident: deps.recordIncident, host: deps.host, home, fsDirs })

  const prompts = new Map() // id → { resolve, reject, timer }
  function promptVia(c, pluginId) {
    return (req) => new Promise((resolve, reject) => {
      const id = crypto.randomBytes(8).toString('hex')
      const timer = setTimeout(() => { prompts.delete(id); send(c, { t: 'prompt-cancel', id }); reject(Object.assign(new Error('权限询问超时，没有回答'), { code: 'EWTPERM', permission: req.permission })) }, PROMPT_TIMEOUT)
      prompts.set(id, { resolve, timer })
      send(c, { t: 'prompt', id, plugin: pluginId, req: { pluginName: req.pluginName, permission: req.permission, scope: req.scope, reason: req.reason, title: req.info?.title || req.permission, description: req.info?.description || '', risk: req.info?.risk || 'medium' } })
    })
  }

  const wss = new deps.WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 << 20 })
  wss.on('connection', (ws, req, clientId) => {
    let c = clients.get(clientId)
    if (!c) { c = { id: clientId, ws: null, queue: [], visible: true, test: false, seen: Date.now(), running: new Map() }; clients.set(clientId, c) }
    if (open(c) && c.ws !== ws) try { c.ws.close(4000, 'replaced') } catch {}
    c.ws = ws
    c.test = isTestHost(req.headers.host) // 经本机访问的（自动化测试）：问题报告记成测试、不推送
    c.seen = Date.now()
    for (const m of c.queue.splice(0)) ws.send(JSON.stringify(m))
    ws.send(JSON.stringify({ t: 'asks', list: asks.list() }))
    ws.on('message', async (raw) => {
      c.seen = Date.now()
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.t === 'vis') c.visible = !!msg.visible
      else if (msg.t === 'prompt-answer') { const p = prompts.get(msg.id); if (p) { prompts.delete(msg.id); clearTimeout(p.timer); p.resolve(msg.answer) } }
      else if (msg.t === 'ask-answer') { try { asks.answer(msg.id, msg.answer, msg.text) } catch {} }
      else if (msg.t === 'session-end') { const m = catalog.get(String(msg.plugin)); if (m) perms.endSession(m) }
      else if (msg.t === 'cancel') c.running.get(msg.id)?.ac.abort()
      else if (msg.t === 'tool-result') {
        const w = c.running.get(msg.id)?.tools.get(msg.rid)
        if (w) { c.running.get(msg.id).tools.delete(msg.rid); msg.ok ? w.resolve(msg.value) : w.reject(new Error(String(msg.error?.message || msg.error || 'tool failed').slice(0, 2000))) }
      }
      else if (msg.t === 'call') {
        const id = msg.id
        const ctx = { client: c.id, test: c.test, visible: () => c.visible, prompt: promptVia(c, msg.plugin) }
        // 流式：片段、工具回调发给前端（前端再转给插件页），cancel 取消；工具 2 分钟没回算失败
        let run = null
        if (msg.stream === true && !c.running.has(id)) {
          run = { ac: new AbortController(), tools: new Map(), rid: 0 }
          c.running.set(id, run)
          Object.assign(ctx, {
            signal: run.ac.signal,
            chunk: (data) => send(c, { t: 'chunk', id, data }),
            callTool: (name, args) => new Promise((resolve, reject) => {
              const rid = ++run.rid
              const timer = setTimeout(() => { run.tools.delete(rid); reject(new Error(`插件页的工具 ${name} 没有回应`)) }, 120000)
              run.tools.set(rid, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
              send(c, { t: 'tool', id, rid, name, args })
            }),
          })
        }
        try {
          const value = await rpc.call(ctx, String(msg.plugin), String(msg.method), msg.args)
          send(c, { t: 'result', id, ok: true, value })
        } catch (e) {
          if (!e.code) console.error(`plugins: ${msg.plugin} ${msg.method} ${e.message}`, e)
          send(c, { t: 'result', id, ok: false, error: { message: e.message, code: e.code || 'EERROR', permission: e.permission } })
        } finally {
          if (run) { c.running.delete(id); for (const w of run.tools.values()) w.reject(new Error('调用已结束')) }
        }
      }
    })
    ws.on('close', () => { c.seen = Date.now() })
  })

  // ---------- 插件静态文件 ----------
  const runtimeBoot = runtimeTable()
  async function boot(m) {
    const db = await dbFor(m)
    // 启动数据里带上插件的全部文档（含 dbStorage 的键和墓碑），插件页里 db / dbStorage 的同步读写都在本地副本上做
    return {
      plugin: { id: m.id, name: m.name, version: m.version, description: m.description, features: m.features, logo: m.logo },
      platform: { name: PLATFORM, version: VERSION, api: PLUGIN_API },
      ...runtimeBoot,
      db: {
        docs: [...Object.values(db.docs), ...Object.entries(db.tombstones).map(([id, rev]) => ({ _id: id, _rev: rev, _deleted: true }))], // docs / tombstones 是 DocDb 的内部字段，没有对外的全量接口
        atts: Object.fromEntries(Object.entries(db.atts).map(([id, a]) => [id, a.type])),
      },
    }
  }
  const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

  async function serveFile(req, res, id, rel) {
    const m = catalog.get(id)
    if (!m) return notFound(res)
    const dir = path.resolve(m.dir)
    const parts = rel.split('/').filter(Boolean)
    if (!parts.length) parts.push(...m.main.split('/'))
    if (parts.some((p) => p.startsWith('.') || p.includes('\\'))) return notFound(res)
    const file = path.resolve(dir, ...parts.map((p) => { try { return decodeURIComponent(p) } catch { return p } }))
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound(res)
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
    // 插件页带完整 Referer：下面靠它认出「同一个插件自己的页面」发的跨域请求
    const head = { 'content-type': type, 'content-security-policy': csp(req.headers.host), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer-when-downgrade', 'cache-control': 'no-cache', vary: 'Origin, Referer' }
    // 插件页是不透明来源，它 fetch 自己的文件、加载 <script type="module" crossorigin> 都是跨域请求（Origin: null），没有 CORS 头就失败。
    // 只放行 Referer 是同一个插件页面的（浏览器不让页面伪造 Referer）：别的网站里的沙盒 iframe 同样是 Origin: null，但 Referer 对不上
    const ref = String(req.headers.referer || '')
    if (req.headers.origin === 'null' && [`http://${req.headers.host}/plugins/${m.id}/`, `https://${req.headers.host}/plugins/${m.id}/`].some((p) => ref.startsWith(p))) head['access-control-allow-origin'] = 'null'
    if (type.startsWith('text/html')) {
      let html = fs.readFileSync(file, 'utf8')
      const inject = `<script>window.__paneRemoteBoot=${safeJson(await boot(m))}</script><script src="/plugins/_runtime.js"></script>${m.preload ? `<script src="/plugins/${m.id}/${m.preload}"></script>` : ''}`
      const at = /<head[^>]*>/i.exec(html)
      html = at ? html.slice(0, at.index + at[0].length) + inject + html.slice(at.index + at[0].length) : inject + html
      res.writeHead(200, { ...head, 'cache-control': 'no-store' })
      return res.end(html)
    }
    const st = fs.statSync(file)
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end() }
    res.writeHead(200, { ...head, etag, 'content-length': st.size })
    fs.createReadStream(file).pipe(res)
  }
  function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found') }
  function json(res, code, body) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }

  /** 处理 HTTP；不是平台的路径返回 false。body 是已经解析好的 POST JSON（由 server.mjs 读） */
  async function handle(req, res, url, readJson) {
    const p = url.pathname
    if (p === '/plugins/_runtime.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      res.end(fs.readFileSync(RUNTIME))
      return true
    }
    const fm = /^\/plugins\/([a-z0-9][a-z0-9._-]{0,127})(\/.*)?$/.exec(p)
    if (fm && req.method === 'GET') {
      if (!fm[2]) { res.writeHead(301, { location: `/plugins/${fm[1]}/` }); res.end(); return true }
      await serveFile(req, res, fm[1], fm[2])
      return true
    }
    if (!p.startsWith('/api/plugins')) return false
    const plugin = () => { const m = catalog.get(String(url.searchParams.get('plugin') || '')); if (!m) throw new Error('没有这个插件'); return m }
    try {
      if (p === '/api/plugins' && req.method === 'GET') return json(res, 200, { platform: PLATFORM, version: VERSION, api: PLUGIN_API, plugins: catalog.list(), problems: catalog.problems() }), true
      if (p === '/api/plugins/support' && req.method === 'GET') return json(res, 200, supportTable()), true
      if (p === '/api/plugins/audit' && req.method === 'GET') return json(res, 200, audit.list(url.searchParams.get('plugin') || '', Math.min(500, Number(url.searchParams.get('n')) || 100))), true
      if (p === '/api/plugins/asks' && req.method === 'GET') return json(res, 200, asks.list()), true
      if (p === '/api/plugins/permissions' && req.method === 'GET') return json(res, 200, perms.list(plugin())), true
      if (p === '/api/plugins/fs-dirs' && req.method === 'GET') return json(res, 200, { dirs: fsDirs.get(plugin().id), private: `${PRIVATE_DIR}/${plugin().id}` }), true
      if (p === '/api/plugins/fs-dirs' && req.method === 'POST') {
        const b = await readJson()
        const m = catalog.get(String(b.plugin || ''))
        if (!m) throw new Error('没有这个插件')
        return json(res, 200, { dirs: fsDirs.set(m.id, b.dirs), private: `${PRIVATE_DIR}/${m.id}` }), true
      }
      if (p === '/api/plugins/permissions' && req.method === 'POST') {
        const b = await readJson()
        const m = catalog.get(String(b.plugin || ''))
        if (!m) throw new Error('没有这个插件')
        if (b.reset === true) perms.reset(m)
        else if (typeof b.permission === 'string' && ['grant', 'deny', 'ask'].includes(b.decision)) perms.set(m, b.permission, b.decision)
        else throw new Error('bad request')
        return json(res, 200, perms.list(m)), true
      }
    } catch (e) { return json(res, 400, { error: e.message }), true }
    json(res, 404, { error: 'not found' })
    return true
  }

  /** WS 升级（身份、来源由 server.mjs 查过） */
  function upgrade(req, socket, head, url) {
    const client = url.searchParams.get('client') || ''
    if (!/^[\w-]{8,64}$/.test(client)) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, client))
  }

  return {
    apiVersion: PLUGIN_API,
    handle,
    upgrade,
    /** /api/agent/answer 也能答插件的问题（推送点进来、Inbox 里答） */
    answerAsk: (id, answer, text) => (asks.has(id) ? asks.answer(id, answer, text) : false),
    flush: () => { for (const db of dbs.values()) db.flushSync() },
    // 测试用
    _rpc: rpc, _perms: perms, _audit: audit, _catalog: catalog, _asks: asks, _fsDirs: fsDirs,
  }
}
