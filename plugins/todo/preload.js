// 待办：数据层 + 给 agent 的工具（plugin.json 的 tools 声明，这里 registerTool 实现）。
// 同一份 preload 在三个地方跑：uTools 里（Node 的 preload）、手机上的插件页（<script>，页面用 window.todoStore）、
// pane-remote 服务端上的无界面工具运行时（agent 经 MCP 调用时）。只用 utools.db，不用 Node 模块。
// 一条待办是一个文档：_id = todo/<时间>-<随机>，status open | done。
;(function () {
  'use strict'
  var PREFIX = 'todo/'
  var PRIORITIES = ['high', 'normal', 'low']
  var db = window.utools.db

  function now() { return Date.now() }
  function newId() { return PREFIX + now().toString(36) + Math.random().toString(36).slice(2, 6) }
  function fullId(id) { id = String(id || '').trim(); return id.indexOf(PREFIX) === 0 ? id : PREFIX + id }
  function text(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : '' }
  function tags(v) {
    var list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : []
    var out = []
    list.forEach(function (t) { t = text(String(t), 24).replace(/^#/, ''); if (t && out.indexOf(t) < 0) out.push(t) })
    return out.slice(0, 8)
  }
  function base(p) { p = String(p || '').replace(/\/+$/, ''); return p ? p.slice(p.lastIndexOf('/') + 1) || p : '' }

  /** 对外的样子：id 不带前缀，字段固定 */
  function view(d) {
    return {
      id: d._id.slice(PREFIX.length),
      title: d.title,
      note: d.note || '',
      status: d.status,
      priority: d.priority || 'normal',
      tags: d.tags || [],
      project: d.project || '',
      source: d.source || null,
      created: d.created,
      updated: d.updated,
      done_at: d.done_at || null,
    }
  }
  function all() { return db.allDocs(PREFIX).filter(function (d) { return d && d.title }) }
  function get(id) {
    var d = db.get(fullId(id))
    if (!d || !d.title) throw new Error('没有这条待办：' + id)
    return d
  }
  // 本地副本上写，冲突只会在别处刚改过的一瞬间出现：重读一次再写
  function save(id, change) {
    for (var i = 0; i < 3; i++) {
      var d = get(id)
      change(d)
      d.updated = now()
      var r = db.put(d)
      if (r && r.ok) return view(Object.assign(d, { _rev: r.rev }))
      if (!r || r.name !== 'conflict') throw new Error((r && r.message) || '保存失败')
    }
    throw new Error('保存冲突，稍后再试')
  }

  var store = {
    PRIORITIES: PRIORITIES,
    base: base,
    /** source: { agent, pane, cwd } | { by: 'phone' } */
    add: function (input, source) {
      input = input || {}
      var title = text(input.title, 200)
      if (!title) throw new Error('待办要有标题')
      var t = now()
      var doc = {
        _id: newId(),
        title: title,
        note: text(input.note, 4000),
        status: 'open',
        priority: PRIORITIES.indexOf(input.priority) >= 0 ? input.priority : 'normal',
        tags: tags(input.tags),
        project: text(input.project, 500) || (source && source.cwd) || '',
        source: source || null,
        created: t,
        updated: t,
      }
      var r = db.put(doc)
      if (!r || !r.ok) throw new Error((r && r.message) || '保存失败')
      doc._rev = r.rev
      return view(doc)
    },
    update: function (id, patch) {
      patch = patch || {}
      return save(id, function (d) {
        if (patch.title !== undefined) { var t = text(patch.title, 200); if (!t) throw new Error('标题不能为空'); d.title = t }
        if (patch.note !== undefined) d.note = text(patch.note, 4000)
        if (patch.priority !== undefined) { if (PRIORITIES.indexOf(patch.priority) < 0) throw new Error('priority 只能是 high / normal / low'); d.priority = patch.priority }
        if (patch.tags !== undefined) d.tags = tags(patch.tags)
        if (patch.project !== undefined) d.project = text(patch.project, 500)
        if (patch.status !== undefined) {
          if (patch.status !== 'open' && patch.status !== 'done') throw new Error('status 只能是 open / done')
          if (patch.status !== d.status) d.done_at = patch.status === 'done' ? now() : null
          d.status = patch.status
        }
      })
    },
    setDone: function (id, done, note) {
      return save(id, function (d) {
        d.status = done ? 'done' : 'open'
        d.done_at = done ? now() : null
        if (note) d.note = (d.note ? d.note + '\n' : '') + text(note, 1000)
      })
    },
    remove: function (id) {
      var d = get(id)
      var r = db.remove(d)
      if (!r || !r.ok) throw new Error((r && r.message) || '删除失败')
      return view(d)
    },
    /** status: open | done | all；project: 路径（含子目录）| 'all'；query 搜标题和备注 */
    list: function (opts) {
      opts = opts || {}
      var status = opts.status || 'open'
      var project = opts.project && opts.project !== 'all' ? String(opts.project).replace(/\/+$/, '') : ''
      var q = text(opts.query, 200).toLowerCase()
      var tag = text(opts.tag, 24).replace(/^#/, '')
      var rank = { high: 0, normal: 1, low: 2 }
      var list = all().filter(function (d) {
        if (status !== 'all' && d.status !== status) return false
        if (project && !(d.project === project || String(d.project || '').indexOf(project + '/') === 0)) return false
        if (tag && (d.tags || []).indexOf(tag) < 0) return false
        if (q && (d.title + '\n' + (d.note || '')).toLowerCase().indexOf(q) < 0) return false
        return true
      })
      list.sort(function (a, b) {
        if (a.status !== b.status) return a.status === 'open' ? -1 : 1
        if (a.status === 'done') return (b.done_at || 0) - (a.done_at || 0)
        return (rank[a.priority] - rank[b.priority]) || (b.created - a.created)
      })
      return list.map(view)
    },
  }
  window.todoStore = store

  // ---------- 给 agent 的工具（说明和参数在 plugin.json 的 tools 里） ----------
  if (typeof window.utools.registerTool !== 'function') return
  function sourceOf(ctx) {
    var c = ctx && ctx.caller
    if (!c) return { by: 'agent' }
    return { by: 'agent', agent: c.agent || null, pane: c.pane == null ? null : c.pane, cwd: c.cwd || null }
  }
  function projectArg(p, ctx) {
    if (p === 'current') return (ctx && ctx.caller && ctx.caller.cwd) || ''
    return p || ''
  }
  window.utools.registerTool('add', function (p, ctx) {
    var src = sourceOf(ctx)
    var input = { title: p.title, note: p.note, priority: p.priority, tags: p.tags, project: p.project === undefined ? src.cwd : projectArg(p.project, ctx) }
    return { added: store.add(input, src) }
  })
  window.utools.registerTool('list', function (p, ctx) {
    var limit = Math.max(1, Math.min(200, Number(p.limit) || 50))
    var items = store.list({ status: p.status, project: projectArg(p.project, ctx) || 'all', query: p.query, tag: p.tag })
    return { total: items.length, items: items.slice(0, limit) }
  })
  window.utools.registerTool('update', function (p) {
    var patch = {}
    ;['title', 'note', 'priority', 'tags', 'status', 'project'].forEach(function (k) { if (p[k] !== undefined) patch[k] = p[k] })
    return { updated: store.update(p.id, patch) }
  })
  window.utools.registerTool('done', function (p) {
    return { updated: store.setDone(p.id, p.reopen !== true, p.note) }
  })
  window.utools.registerTool('remove', function (p) {
    return { removed: store.remove(p.id) }
  })
})()
