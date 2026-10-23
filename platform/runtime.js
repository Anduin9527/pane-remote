// pane-remote 插件运行时：注入到每个插件页（iframe，sandbox 没有 allow-same-origin）的最前面。
// 提供 window.whatevertools（原生 API 子集，也挂在 Symbol.for('whatevertools.api') 上，getApi() 能拿到）和 window.utools（旧名映射）。
// 所有要宿主做的调用经 postMessage 交给 pane-remote 前端，前端再转给服务端的平台 RPC（查权限、记审计、分发）。
//   - db / dbStorage：启动数据里带着插件的全部文档，同步读写在本地副本上做，改动攒一下推给服务端（db.push，按 rev 裁决）；
//     别处的改动（agent 经插件工具写的）服务端推过来（db），合并后调 onDbPull 的回调；连接断过就拿一次全量（resync → db.pull）
//   - 不支持的 API 也有同名函数，调用时抛 EWTUNSUPPORTED，错误里写明原因（比如要 Mac 端的 pane-host）
//   - 未捕获的异常、未处理的 Promise、console.error 自动报给平台的问题报告（来源 plugin:<id>）
//   - 流式调用（AI）：call 带 stream: true，前端回 chunk 片段；AI 要调工具时前端发 tool，这里跑 registerTool 注册的
//     （或 uTools 习惯的 window 上的同名函数）再回 tool-result；abort() 发 cancel
;(function () {
  'use strict'
  var BOOT = window.__paneRemoteBoot
  try { delete window.__paneRemoteBoot } catch (e) { window.__paneRemoteBoot = undefined }
  if (!BOOT || window.parent === window) return
  var P = BOOT.plugin
  var SUPPORT = BOOT.support || {}
  var LEGACY = BOOT.legacy || {}
  var STORAGE_PREFIX = '\u0000storage/'
  var host = window.parent

  // ---------- 和前端的通道 ----------
  var seq = 0
  var pending = {}
  function post(msg) { msg.__paneRemote = 1; host.postMessage(msg, '*') } // 只有本站能嵌入这个页面（CSP frame-ancestors 'self'）
  function wtError(e) {
    var err = new Error(e && e.message || String(e))
    err.code = e && e.code || 'EERROR'
    if (e && e.permission) err.permission = e.permission
    return err
  }
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq
      pending[id] = { resolve: resolve, reject: reject }
      post({ t: 'call', id: id, method: method, args: args || {} })
    })
  }
  // 流式调用：返回 { promise, abort }；onChunk 收片段
  var streams = {}
  function callStream(method, args, onChunk) {
    var id = ++seq
    var p = new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject }
      streams[id] = { onChunk: onChunk }
      post({ t: 'call', id: id, method: method, args: args || {}, stream: true })
    })
    var done = function () { delete streams[id] }
    p.then(done, done)
    return { promise: p, abort: function () { if (streams[id]) post({ t: 'cancel', id: id }) } }
  }
  var tools = {}
  function runTool(m) {
    var fn = tools[m.name] || (typeof window[m.name] === 'function' ? window[m.name] : null)
    Promise.resolve().then(function () {
      if (!fn) throw new Error('没有注册工具 ' + m.name)
      return fn(m.args || {})
    }).then(function (v) { post({ t: 'tool-result', id: m.id, rid: m.rid, ok: true, value: v === undefined ? null : clone(v) }) },
      function (e) { post({ t: 'tool-result', id: m.id, rid: m.rid, ok: false, error: { message: String(e && e.message || e) } }) })
  }
  function unsupported(name, why) {
    var e = new Error('[pane-remote] 不支持 ' + name + (why ? '：' + why : ''))
    e.code = 'EWTUNSUPPORTED'
    return e
  }

  // ---------- 生命周期 ----------
  var enterFns = [], leaveFns = [], readyFns = [], themeFns = []
  var lastEnter = null, ready = false
  function safe(fn, arg) { try { fn(arg) } catch (e) { setTimeout(function () { throw e }) } }
  window.addEventListener('message', function (ev) {
    if (ev.source !== host || !ev.data || ev.data.__paneRemote !== 1) return
    var m = ev.data
    if (m.t === 'result') {
      var p = pending[m.id]
      if (!p) return
      delete pending[m.id]
      if (m.ok) p.resolve(m.value)
      else p.reject(wtError(m.error))
    } else if (m.t === 'chunk') {
      var st = streams[m.id]
      if (st && st.onChunk) safe(st.onChunk, m.data)
    } else if (m.t === 'tool') {
      if (streams[m.id]) runTool(m)
    } else if (m.t === 'enter') {
      lastEnter = m.action
      enterFns.forEach(function (fn) { safe(fn, m.action) })
    } else if (m.t === 'leave') {
      flush()
      leaveFns.forEach(function (fn) { safe(fn) })
    } else if (m.t === 'db') {
      pullApply(m.docs)
    } else if (m.t === 'resync') {
      call('db.pull', {}).then(function (r) { pullApply(r && r.docs) }, function () {})
    }
  })
  function onReady() {
    if (ready) return
    ready = true
    readyFns.forEach(function (fn) { safe(fn) })
    post({ t: 'ready' })
  }
  if (document.readyState === 'complete') setTimeout(onReady)
  else window.addEventListener('load', onReady)

  // ---------- 数据库（本地副本） ----------
  var docs = {}, tombs = {}, atts = (BOOT.db && BOOT.db.atts) || {}, attCache = {}
  ;((BOOT.db && BOOT.db.docs) || []).forEach(function (d) { if (d._deleted) tombs[d._id] = d._rev; else docs[d._id] = d })
  var outbox = {}, outN = 0, flushTimer = null, failing = false
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)) }
  function revN(rev) { return rev ? Number(String(rev).split('-')[0]) || 0 : 0 }
  function nextRev(prev) { return (revN(prev) + 1) + '-' + Math.random().toString(16).slice(2, 10) + Date.now().toString(16) }
  function dbErr(id, name, message) { return { id: id, error: true, name: name, message: message } }
  function queue(doc) {
    if (!outbox[doc._id]) outN++
    outbox[doc._id] = doc
    if (!flushTimer) flushTimer = setTimeout(flush, 50)
  }
  function flush() {
    clearTimeout(flushTimer)
    flushTimer = null
    if (!outN) return
    var list = Object.keys(outbox).map(function (k) { return outbox[k] })
    outbox = {}
    outN = 0
    call('db.push', { docs: list }).then(function () { failing = false }, function (e) {
      // 推不上去（断网、权限）：放回去稍后再推，新的改动优先
      list.forEach(function (d) { if (!outbox[d._id]) { outbox[d._id] = d; outN++ } })
      if (!failing) { failing = true; console.warn('[pane-remote] 数据没存上，稍后重试：' + e.message) }
      if (!flushTimer) flushTimer = setTimeout(flush, 3000)
    })
  }
  window.addEventListener('pagehide', flush)
  // 别处的改动（服务端推来的、重新同步拿到的全量）：rev 赢了才收（规则同服务端的 DocDb）；还没推上去的本地改动先不动，
  // 推上去后由服务端裁决。收下的交给 onDbPull 的回调（uTools 的「数据从别的设备同步过来」）
  var pullFns = []
  function revWins(a, b) { var na = revN(a), nb = revN(b); return na !== nb ? na > nb : a > b }
  function pullApply(list) {
    var applied = []
    ;(Array.isArray(list) ? list : []).forEach(function (d) {
      if (!d || !d._id || !d._rev || outbox[d._id]) return
      var cur = docs[d._id] ? docs[d._id]._rev : tombs[d._id]
      if (cur && (cur === d._rev || !revWins(d._rev, cur))) return
      if (d._deleted) { delete docs[d._id]; tombs[d._id] = d._rev } else { docs[d._id] = clone(d); delete tombs[d._id] }
      applied.push(clone(d))
    })
    if (applied.length) pullFns.forEach(function (fn) { safe(fn, clone(applied)) })
  }
  function putOne(input) {
    if (!input || typeof input !== 'object' || typeof input._id !== 'string' || !input._id) return { res: dbErr(String(input && input._id || ''), 'bad_request', 'doc._id must be a non-empty string') }
    var id = input._id, cur = docs[id]
    if (cur && cur._rev !== input._rev) return { res: dbErr(id, 'conflict', 'Document update conflict') }
    if (!cur && input._rev && !input._deleted && input._rev !== tombs[id]) return { res: dbErr(id, 'conflict', 'Document update conflict') }
    if (atts[id]) return { res: dbErr(id, 'conflict', 'Document update conflict') }
    if (input._deleted) {
      if (!cur) return { res: dbErr(id, 'not_found', 'missing') }
      var rev = nextRev(cur._rev)
      delete docs[id]
      tombs[id] = rev
      queue({ _id: id, _rev: rev, _deleted: true })
      return { res: { id: id, ok: true, rev: rev } }
    }
    var body
    try { body = JSON.stringify(input) } catch (e) { return { res: dbErr(id, 'bad_request', 'doc is not serializable: ' + e.message) } }
    if (body.length > 1024 * 1024) return { res: dbErr(id, 'exception', 'doc size exceeds 1M') }
    var doc = JSON.parse(body)
    doc._rev = nextRev(cur ? cur._rev : tombs[id])
    docs[id] = doc
    delete tombs[id]
    queue(doc)
    return { res: { id: id, ok: true, rev: doc._rev } }
  }
  var db = {
    put: function (doc) { return putOne(doc).res },
    get: function (id) { return docs[id] ? clone(docs[id]) : null },
    remove: function (docOrId) {
      var id = typeof docOrId === 'string' ? docOrId : docOrId && docOrId._id
      var cur = docs[id]
      if (!cur) return dbErr(String(id), 'not_found', 'missing')
      if (typeof docOrId !== 'string' && docOrId._rev !== undefined && docOrId._rev !== cur._rev) return dbErr(id, 'conflict', 'Document update conflict')
      var d = clone(cur)
      d._deleted = true
      return putOne(d).res
    },
    bulk: function (list) {
      if (!Array.isArray(list)) return [dbErr('', 'bad_request', 'docs must be an array')]
      return list.map(function (d) { return putOne(d).res })
    },
    all: function (filter) {
      var list
      if (Array.isArray(filter)) list = filter.map(function (id) { return docs[id] }).filter(Boolean)
      else {
        var prefix = typeof filter === 'string' ? filter : ''
        list = Object.keys(docs).filter(function (id) { return id.indexOf(STORAGE_PREFIX) !== 0 && id.indexOf(prefix) === 0 }).map(function (id) { return docs[id] })
      }
      return clone(list.sort(function (a, b) { return a._id < b._id ? -1 : a._id > b._id ? 1 : 0 }))
    },
    putAttachment: function (id, data, type) {
      var bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      var bin = ''
      for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
      return call('db.putAttachment', { id: id, data: btoa(bin), type: type }).then(function (r) { if (r && r.ok) { atts[id] = type || 'application/octet-stream'; attCache[id] = bytes } return r })
    },
    getAttachment: function (id) { return attCache[id] || null },
    getAttachmentType: function (id) { return atts[id] || null },
    syncState: function () { return null },
    onPull: function (fn) { if (typeof fn === 'function') pullFns.push(fn) },
  }
  db.promises = {
    put: function (d) { return Promise.resolve(db.put(d)) },
    get: function (id) { return Promise.resolve(db.get(id)) },
    remove: function (d) { return Promise.resolve(db.remove(d)) },
    bulk: function (l) { return Promise.resolve(db.bulk(l)) },
    all: function (f) { return Promise.resolve(db.all(f)) },
    putAttachment: db.putAttachment,
    getAttachment: function (id) {
      if (attCache[id]) return Promise.resolve(attCache[id])
      if (!atts[id]) return Promise.resolve(null)
      return call('db.getAttachment', { id: id }).then(function (b64) {
        if (!b64) return null
        var s = atob(b64), u = new Uint8Array(s.length)
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
        return (attCache[id] = u)
      })
    },
    getAttachmentType: function (id) { return Promise.resolve(db.getAttachmentType(id)) },
  }
  var kv = {
    set: function (key, value) {
      var id = STORAGE_PREFIX + String(key), cur = docs[id]
      putOne({ _id: id, _rev: cur ? cur._rev : tombs[id], value: value === undefined ? null : clone(value) })
    },
    get: function (key) { var d = docs[STORAGE_PREFIX + String(key)]; return d ? (clone(d.value) == null ? null : clone(d.value)) : null },
    remove: function (key) { var d = docs[STORAGE_PREFIX + String(key)]; return d ? !!db.remove(d).ok : false },
  }

  // ---------- 原生 API ----------
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  if (dark && dark.addEventListener) dark.addEventListener('change', function () { themeFns.forEach(function (fn) { safe(fn, dark.matches) }) })
  function fire(p) { p.catch(function (e) { console.warn('[pane-remote] ' + e.message) }) }
  var wt = {
    identity: { platform: { name: BOOT.platform.name, version: BOOT.platform.version, api: BOOT.platform.api }, plugin: { id: P.id, name: P.name, version: P.version } },
    supports: function (name) { var n = LEGACY[name] || name, s = SUPPORT[n]; return !s || s === 'none' ? false : s },
    lifecycle: {
      onEnter: function (fn) { enterFns.push(fn); if (lastEnter) setTimeout(function () { safe(fn, lastEnter) }) },
      onLeave: function (fn) { leaveFns.push(fn) },
      onReady: function (fn) { readyFns.push(fn); if (ready) setTimeout(function () { safe(fn) }) },
      exit: function () { flush(); post({ t: 'exit' }) },
    },
    window: { type: 'main' },
    panel: { setHeight: function () {} },
    features: { list: function () { return clone(P.features) } },
    db: db,
    kv: kv,
    system: {
      // uTools 的 showNotification 是同步、不返回结果的：这里发出去就算，失败只在控制台提示
      notify: function (body, title) { fire(call('system.notify', { body: String(body == null ? '' : body), title: typeof title === 'string' && !/^[\w-]+$/.test(title) ? title : '' })) },
      appName: function () { return 'pane-remote' },
      appVersion: function () { return BOOT.platform.version },
      isDev: function () { return false },
      isMac: function () { return false },
      isWindows: function () { return false },
      isLinux: function () { return false },
      isDark: function () { return !!(dark && dark.matches) },
      onThemeChange: function (fn) { themeFns.push(fn) },
    },
    clipboard: { writeText: function (text) { fire(call('clipboard.writeText', { text: String(text == null ? '' : text) })); return true } },
    shell: { openExternal: function (url) { return call('shell.openExternal', { url: String(url) }).then(function () { return true }) } },
    launch: { open: function (target, payload) { fire(call('launch.open', { target: target, payload: payload })); return true } },
    // AI：本机 Mac 上已登录的 Claude Code / Codex / cursor-agent（经 pane-host）。和 whatevertools 一样：
    // chat(options, onChunk) 返回带 abort() 的 Promise；传了 onChunk 时 resolve undefined，否则 resolve 完整的消息
    ai: {
      chat: function (options, onChunk) {
        var o = options || {}
        var s = callStream('ai.chat', { model: o.model, messages: o.messages || [], tools: o.tools }, typeof onChunk === 'function' ? onChunk : null)
        var p = s.promise.then(function (msg) { return typeof onChunk === 'function' ? undefined : msg })
        p.abort = s.abort
        return p
      },
      models: function () { return call('ai.models', {}) },
    },
    tools: { register: function (name, handler) { if (typeof handler === 'function') tools[String(name)] = handler } },
    platform: {
      info: function () { return { name: BOOT.platform.name, version: BOOT.platform.version, api: BOOT.platform.api, plugin: P.id } },
      call: call, // 以后加的 platform.* 方法不用改运行时也能调
      // AI 详细版：responseFormat（结构化输出）、reasoning、tools；返回 { text, structured, usage, ttftMs, ms, model, … }。opts.signal 取消
      ai: {
        complete: function (req, opts) {
          opts = opts || {}
          var s = callStream('platform.ai.complete', req || {}, typeof opts.onChunk === 'function' ? opts.onChunk : null)
          if (opts.signal) { if (opts.signal.aborted) s.abort(); else opts.signal.addEventListener('abort', s.abort) }
          s.promise.abort = s.abort
          return s.promise
        },
      },
      // 明确要用 Mac 的剪贴板 / 在 Mac 上打开（不看描述文件）
      mac: {
        clipboard: {
          readText: function () { return call('platform.mac.clipboard.readText', {}) },
          writeText: function (text) { return call('platform.mac.clipboard.writeText', { text: String(text == null ? '' : text) }) },
        },
        openUrl: function (url) { return call('platform.mac.openUrl', { url: String(url) }) },
      },
      // Mac 上的只读文件：相对路径在插件私有目录里；别的目录要用户在插件权限设置里加过
      fs: {
        roots: function () { return call('platform.fs.roots', {}) },
        list: function (p, o) { return call('platform.fs.list', { path: p || '', root: o && o.root }) },
        stat: function (p, o) { return call('platform.fs.stat', { path: p, root: o && o.root }) },
        readText: function (p, o) { return call('platform.fs.read', { path: p, root: o && o.root, maxBytes: o && o.maxBytes }).then(function (r) { return r.data }) },
        read: function (p, o) {
          return call('platform.fs.read', { path: p, root: o && o.root, maxBytes: o && o.maxBytes, encoding: 'base64' }).then(function (r) {
            var s = atob(r.data), u = new Uint8Array(s.length)
            for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
            return u
          })
        },
      },
      incident: { report: function (o) { return call('platform.incident.report', o || {}) } },
      storage: {
        get: function (group, key) { return call('platform.storage.get', { group: group, key: key }) },
        set: function (group, key, value) { return call('platform.storage.set', { group: group, key: key, value: value }) },
        remove: function (group, key) { return call('platform.storage.remove', { group: group, key: key }) },
        keys: function (group) { return call('platform.storage.keys', { group: group }) },
      },
      // agent 会话：列出在跑的、往会话里发一段话（执行 / 检查之类）、给会话留言（它下次收到用户消息时看到）
      sessions: {
        list: function () { return call('platform.sessions.list', {}) },
        send: function (o) { return call('platform.sessions.send', o || {}) },
        note: function (o) { return call('platform.sessions.note', o || {}) },
      },
      agent: {
        ask: function (o) { return call('platform.agent.ask', o || {}) },
        notify: function (o) { return call('platform.agent.notify', o || {}) },
        tools: { register: function () { return Promise.reject(unsupported('platform.agent.tools.register', '计划中：插件工具经 MCP 暴露给 agent')) } },
      },
    },
  }
  // 规格表里有、这里没实现的：放一个会报错的同名函数，插件能用 supports() 先判断
  function getPath(obj, name) { return name.split('.').reduce(function (o, k) { return o == null ? undefined : o[k] }, obj) }
  function setPath(obj, name, v) {
    var ks = name.split('.'), last = ks.pop(), o = obj
    for (var i = 0; i < ks.length; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]] }
    if (o[last] === undefined) o[last] = v
  }
  Object.keys(SUPPORT).forEach(function (name) {
    if (getPath(wt, name) !== undefined) return
    var why = (BOOT.why && BOOT.why[name]) || ''
    setPath(wt, name, function () { throw unsupported(name, why) })
  })

  // ---------- uTools 旧名 ----------
  var utools = {}
  Object.keys(LEGACY).forEach(function (old) {
    var v = getPath(wt, LEGACY[old])
    if (v !== undefined) setPath(utools, old, v)
  })
  utools.db.promises = {
    put: db.promises.put, get: db.promises.get, remove: db.promises.remove, bulkDocs: db.promises.bulk, allDocs: db.promises.all,
    postAttachment: db.promises.putAttachment, getAttachment: db.promises.getAttachment, getAttachmentType: db.promises.getAttachmentType,
  }
  utools.showNotification = function (body) { wt.system.notify(body) }

  var g = window
  Object.defineProperty(g, 'whatevertools', { value: wt, writable: false, configurable: false })
  Object.defineProperty(g, Symbol.for('whatevertools.api'), { value: wt, writable: false, configurable: false })
  g.utools = utools
  // uTools 的 preload 是 Node 环境：这里没有 Node，require 一律说明原因
  if (!g.require) g.require = function (name) { throw unsupported("require('" + name + "')", 'preload 里没有 Node.js；读电脑上的文件用 whatevertools.platform.fs') }

  // ---------- 异常自动上报 ----------
  var sent = {}, nSent = 0
  function report(kind, msg, detail) {
    msg = String(msg || '').slice(0, 2000)
    if (!msg || sent[msg] || nSent >= 20) return
    sent[msg] = 1
    nSent++
    call('platform.incident.auto', { kind: kind, msg: msg, detail: String(detail || msg).slice(0, 6000) }).catch(function () {})
  }
  // WebKit 把沙盒（不透明来源）页面里的异常一律报成「Script error.」、不给 error 对象：
  // 定时器、requestAnimationFrame、addEventListener 的回调包一层，先拿到真正的错误再原样抛出
  var caughtAt = 0
  function guard(fn) {
    if (typeof fn !== 'function' || fn.__prGuard) return fn
    var g = function () {
      try { return fn.apply(this, arguments) } catch (e) {
        caughtAt = Date.now()
        report('error', e && e.message ? (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message : String(e), e && e.stack)
        throw e
      }
    }
    g.__prGuard = true
    fn.__prGuarded = g
    return g
  }
  ;['setTimeout', 'setInterval', 'requestAnimationFrame'].forEach(function (name) {
    var orig = window[name]
    if (orig) window[name] = function (fn) { var a = [].slice.call(arguments); a[0] = guard(fn); return orig.apply(window, a) }
  })
  var addEv = EventTarget.prototype.addEventListener, rmEv = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, fn, opt) { return addEv.call(this, type, typeof fn === 'function' ? guard(fn) : fn, opt) }
  EventTarget.prototype.removeEventListener = function (type, fn, opt) { return rmEv.call(this, type, fn && fn.__prGuarded || fn, opt) }
  window.addEventListener('error', function (e) {
    if (!e.message) return // 资源加载失败（img/script 404）没有 message
    if (/^Script error\.?$/.test(e.message) && !e.error && Date.now() - caughtAt < 1000) return // 上面已经报过真正的错误
    report('error', e.message, (e.error && e.error.stack) || (e.filename ? e.filename + ':' + e.lineno + ':' + e.colno : ''))
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    report('rejection', r && r.message ? r.message : String(r), r && r.stack)
  })
  var origError = console.error
  console.error = function () {
    origError.apply(console, arguments)
    try {
      var parts = [].map.call(arguments, function (a) { return a instanceof Error ? a.message : typeof a === 'string' ? a : (function () { try { return JSON.stringify(a) } catch (e) { return String(a) } })() })
      var err = [].find.call(arguments, function (a) { return a instanceof Error })
      report('console', parts.join(' '), err && err.stack)
    } catch (e) {}
  }
})()
