// 待办：数据层 + 给 agent 的工具（plugin.json 的 tools 声明，这里 registerTool 实现）。
// 同一份 preload 在三个地方跑：uTools 里（Node 的 preload）、手机上的插件页（<script>，页面用 window.todoStore）、
// pane-remote 服务端上的无界面工具运行时（agent 经 MCP 调用时）。只用 utools.db，不用 Node 模块。
//
// 一条待办是一个文档（_id = todo/<时间>-<随机>）：
//   status    open（未开始）| in_progress（处理中，claim 是谁在做）| blocked（等你：blocker 是 agent 要你回答 / 处理的事）| done
//   assignee  agent（agent 可做）| human（必须人类）| undecided（待定）
//   priority  high | normal | low；due 截止日期（YYYY-MM-DD，过了还没做完算过期）；tags、links、project（项目目录）
//   source    谁记的：{ by: 'agent', agent, pane, cwd, session } | { by: 'phone' }
//   claim     谁在处理：{ agent, pane, session, at }（agent 调 start、或手机上发给会话执行时记下）
//   log       动态：创建、改状态、评论、提问、回复、发给会话……每条 { at, by: agent | phone, who, kind, text }
//   runs      手机上发给会话执行 / 检查的记录；order 手动排序用（拖动）
//   trashed_at 删除 = 放进回收站，30 天后自动清掉
;(function () {
  'use strict'
  var PREFIX = 'todo/'
  var PRIORITIES = ['high', 'normal', 'low']
  var STATUSES = ['open', 'in_progress', 'blocked', 'done']
  var ASSIGNEES = ['agent', 'human', 'undecided']
  var TRASH_DAYS = 30
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
  function links(v) {
    var list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s+/) : []
    return list.map(function (l) { return text(String(l), 500) }).filter(Boolean).slice(0, 10)
  }
  function due(v) {
    if (v === null || v === '') return null
    var s = text(String(v), 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new Error('due 要写成 YYYY-MM-DD')
    return s
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  function base(p) { p = String(p || '').replace(/\/+$/, ''); return p ? p.slice(p.lastIndexOf('/') + 1) || p : '' }
  function pick(v, list, name) { if (list.indexOf(v) < 0) throw new Error(name + ' 只能是 ' + list.join(' / ')); return v }
  /** 谁做的：agent 调用时是 { by: 'agent', agent, pane, cwd, session }，手机上是 { by: 'phone' } */
  function whoOf(actor) { return !actor || actor.by === 'phone' ? '手机' : actor.agent ? actor.agent + (actor.pane != null ? ' #' + actor.pane : '') : 'agent' }
  function log(d, actor, kind, txt) {
    d.log = (d.log || []).concat([{ at: now(), by: actor && actor.by === 'agent' ? 'agent' : 'phone', who: whoOf(actor), kind: kind, text: text(txt || '', 2000) }]).slice(-60)
  }
  var LABEL = { open: '未开始', in_progress: '处理中', blocked: '等你', done: '已完成', agent: 'agent 可做', human: '必须人类', undecided: '待定', high: '高', normal: '普通', low: '低' }

  /** 对外的样子：id 不带前缀，字段固定 */
  function view(d) {
    return {
      id: d._id.slice(PREFIX.length),
      title: d.title,
      note: d.note || '',
      status: d.status || 'open',
      assignee: d.assignee || 'undecided',
      priority: d.priority || 'normal',
      due: d.due || null,
      overdue: !!(d.due && d.status !== 'done' && !d.trashed_at && d.due < today()),
      tags: d.tags || [],
      links: d.links || [],
      project: d.project || '',
      blocker: d.blocker || null,
      claim: d.claim || null,
      source: d.source || null,
      log: d.log || [],
      runs: d.runs || [],
      order: typeof d.order === 'number' ? d.order : null,
      created: d.created,
      updated: d.updated,
      done_at: d.done_at || null,
      trashed_at: d.trashed_at || null,
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
      var r0 = change(d)
      if (r0 === false) return view(d)
      d.updated = now()
      var r = db.put(d)
      if (r && r.ok) return view(Object.assign(d, { _rev: r.rev }))
      if (!r || r.name !== 'conflict') throw new Error((r && r.message) || '保存失败')
    }
    throw new Error('保存冲突，稍后再试')
  }
  /** 改状态（带上该清的、该记的） */
  function setStatus(d, status, actor, extra) {
    pick(status, STATUSES, 'status')
    var was = d.status || 'open'
    if (status === 'blocked') {
      var b = text(extra && extra.blocker, 2000) || d.blocker
      if (!b) throw new Error('改成 blocked 要写清楚要用户做什么（blocker）')
      d.blocker = b
    } else d.blocker = null
    if (status === 'in_progress' && actor && actor.by === 'agent') d.claim = { agent: actor.agent || null, pane: actor.pane == null ? null : actor.pane, session: actor.session || null, at: now() }
    if (status === 'open' || status === 'done') d.claim = status === 'done' ? d.claim : null
    d.done_at = status === 'done' ? (was === 'done' ? d.done_at : now()) : null
    d.status = status
    if (was !== status) log(d, actor, 'status', LABEL[was] + ' → ' + LABEL[status] + (status === 'blocked' ? '：' + d.blocker : ''))
  }

  var store = {
    PRIORITIES: PRIORITIES, STATUSES: STATUSES, ASSIGNEES: ASSIGNEES, TRASH_DAYS: TRASH_DAYS, LABEL: LABEL,
    base: base, today: today,
    add: function (input, actor) {
      input = input || {}
      var title = text(input.title, 200)
      if (!title) throw new Error('待办要有标题')
      var t = now()
      var doc = {
        _id: newId(),
        title: title,
        note: text(input.note, 4000),
        status: 'open',
        assignee: input.assignee ? pick(input.assignee, ASSIGNEES, 'assignee') : 'undecided',
        priority: input.priority ? pick(input.priority, PRIORITIES, 'priority') : 'normal',
        due: input.due ? due(input.due) : null,
        tags: tags(input.tags),
        links: links(input.links),
        project: text(input.project, 500) || (actor && actor.cwd) || '',
        source: actor || { by: 'phone' },
        created: t,
        updated: t,
        log: [],
      }
      log(doc, actor, 'created', '')
      if (input.status && input.status !== 'open') setStatus(doc, input.status, actor, input)
      var r = db.put(doc)
      if (!r || !r.ok) throw new Error((r && r.message) || '保存失败')
      doc._rev = r.rev
      return view(doc)
    },
    update: function (id, patch, actor) {
      patch = patch || {}
      return save(id, function (d) {
        var changed = []
        if (patch.title !== undefined) { var t = text(patch.title, 200); if (!t) throw new Error('标题不能为空'); if (t !== d.title) { d.title = t; changed.push('标题') } }
        if (patch.note !== undefined && text(patch.note, 4000) !== (d.note || '')) { d.note = text(patch.note, 4000); changed.push('备注') }
        if (patch.priority !== undefined && patch.priority !== d.priority) { d.priority = pick(patch.priority, PRIORITIES, 'priority'); changed.push('优先级 ' + LABEL[d.priority]) }
        if (patch.assignee !== undefined && patch.assignee !== (d.assignee || 'undecided')) { d.assignee = pick(patch.assignee, ASSIGNEES, 'assignee'); changed.push(LABEL[d.assignee]) }
        if (patch.due !== undefined) { var du = due(patch.due); if (du !== (d.due || null)) { d.due = du; changed.push(du ? '截止 ' + du : '去掉截止日期') } }
        if (patch.tags !== undefined) { var tg = tags(patch.tags); if (tg.join() !== (d.tags || []).join()) { d.tags = tg; changed.push('标签') } }
        if (patch.links !== undefined) { d.links = links(patch.links); changed.push('链接') }
        if (patch.project !== undefined && text(patch.project, 500) !== (d.project || '')) { d.project = text(patch.project, 500); changed.push('项目') }
        if (changed.length) log(d, actor, 'edit', changed.join('、'))
        if (patch.status !== undefined) setStatus(d, patch.status, actor, patch)
        else if (patch.blocker !== undefined && d.status === 'blocked') d.blocker = text(patch.blocker, 2000) || d.blocker
      })
    },
    /** agent 开始做（认领）：处理中，记下是哪个会话 */
    start: function (id, actor) { return save(id, function (d) { setStatus(d, 'in_progress', actor) }) },
    setDone: function (id, done, note, actor) {
      return save(id, function (d) {
        setStatus(d, done ? 'done' : 'open', actor)
        if (note) { d.note = (d.note ? d.note + '\n' : '') + text(note, 1000); log(d, actor, 'comment', note) }
      })
    },
    /** 评论 / 进展；needsReply：要用户回答（状态改成「等你」，blocker 就是这句话） */
    comment: function (id, txt, actor, needsReply) {
      var t = text(txt, 2000)
      if (!t) throw new Error('评论不能为空')
      return save(id, function (d) {
        log(d, actor, needsReply ? 'question' : 'comment', t)
        if (needsReply) setStatus(d, 'blocked', actor, { blocker: t })
      })
    },
    /** 手机上回答 agent 的问题：回到处理中（有人认领）或未开始 */
    reply: function (id, txt, actor) {
      var t = text(txt, 2000)
      if (!t) throw new Error('回复不能为空')
      return save(id, function (d) {
        log(d, actor, 'reply', t)
        if (d.status === 'blocked') setStatus(d, d.claim ? 'in_progress' : 'open', actor)
      })
    },
    /** 删除 = 放进回收站（可以恢复） */
    trash: function (id, actor) { return save(id, function (d) { d.trashed_at = now(); log(d, actor, 'trash', '') }) },
    restore: function (id, actor) { return save(id, function (d) { d.trashed_at = null; log(d, actor, 'restore', '') }) },
    /** 彻底删除（只对回收站里的） */
    purge: function (id) {
      var d = get(id)
      if (!d.trashed_at) throw new Error('只能彻底删除回收站里的待办')
      var r = db.remove(d)
      if (!r || !r.ok) throw new Error((r && r.message) || '删除失败')
      return view(d)
    },
    emptyTrash: function () {
      var n = 0
      all().forEach(function (d) { if (d.trashed_at && db.remove(d).ok) n++ })
      return n
    },
    /** 回收站里放了 30 天以上的清掉 */
    purgeOld: function () {
      var cut = now() - TRASH_DAYS * 86400000
      all().forEach(function (d) { if (d.trashed_at && d.trashed_at < cut) db.remove(d) })
    },
    /** 手机上发给会话执行 / 检查：记下来，状态改成处理中、认领人是收到的那个会话 */
    addRun: function (id, run) {
      return save(id, function (d) {
        d.runs = (d.runs || []).concat([run]).slice(-20)
        log(d, { by: 'phone' }, 'run', (run.kind === 'check' ? '发去检查 → ' : '发去执行 → ') + run.agent + ' #' + run.pane + (run.subagent ? '（subagent）' : ''))
        if (run.kind !== 'check' && d.status !== 'done') {
          d.claim = { agent: run.agent, pane: run.pane, session: run.session || null, at: run.at }
          if (d.status !== 'in_progress') { var was = d.status || 'open'; d.status = 'in_progress'; d.blocker = null; log(d, { by: 'phone' }, 'status', LABEL[was] + ' → ' + LABEL.in_progress) }
        }
      })
    },
    /** 补上记下它的会话 id（老的待办只记了 pane） */
    setSession: function (id, session) { return save(id, function (d) { if (d.source && d.source.session === session) return false; d.source = Object.assign({}, d.source || {}, { session: session }) }) },
    /** 拖动排序：放到 before 和 after 两条之间（任一边可以没有） */
    move: function (id, beforeId, afterId) {
      var b = beforeId ? get(beforeId) : null, a = afterId ? get(afterId) : null
      var ob = b && typeof b.order === 'number' ? b.order : null, oa = a && typeof a.order === 'number' ? a.order : null
      var o = ob != null && oa != null ? (ob + oa) / 2 : ob != null ? ob + 1 : oa != null ? oa - 1 : 0
      return save(id, function (d) { d.order = o })
    },
    /** 第一次手动排序：按当前看到的顺序给每条编号 */
    seedOrder: function (ids) {
      ids.forEach(function (id, i) { save(id, function (d) { if (d.order === i) return false; d.order = i }) })
    },
    get: function (id) { return view(get(id)) },
    /**
     * status：active（没做完的：open + in_progress + blocked，默认）| open | in_progress | blocked | done | all | trash
     * 另外 assignee、project（路径，含子目录；'all'）、tag、overdue、query（搜标题和备注）
     * sort：smart（默认：等你 > 过期 > 优先级 > 截止日期 > 新的在前）| due | priority | created | updated | manual
     */
    list: function (opts) {
      opts = opts || {}
      var status = opts.status || 'active'
      var project = opts.project && opts.project !== 'all' ? String(opts.project).replace(/\/+$/, '') : ''
      var q = text(opts.query, 200).toLowerCase()
      var tag = text(opts.tag, 24).replace(/^#/, '')
      var day = today()
      var list = all().filter(function (d) {
        var st = d.status || 'open'
        if (status === 'trash') return !!d.trashed_at
        if (d.trashed_at) return false
        if (status === 'active' && st === 'done') return false
        if (status !== 'active' && status !== 'all' && st !== status) return false
        if (opts.assignee && (d.assignee || 'undecided') !== opts.assignee) return false
        if (opts.overdue && !(d.due && st !== 'done' && d.due < day)) return false
        if (project && !(d.project === project || String(d.project || '').indexOf(project + '/') === 0)) return false
        if (tag && (d.tags || []).indexOf(tag) < 0) return false
        if (q && (d.title + '\n' + (d.note || '') + '\n' + (d.blocker || '')).toLowerCase().indexOf(q) < 0) return false
        return true
      })
      var rank = { high: 0, normal: 1, low: 2 }
      var stRank = { blocked: 0, in_progress: 1, open: 2, done: 3 }
      var sort = opts.sort || 'smart'
      var byDue = function (a, b) { return (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0 }
      list.sort(function (a, b) {
        if (status === 'trash') return b.trashed_at - a.trashed_at
        var da = a.status === 'done', dbn = b.status === 'done'
        if (da !== dbn) return da ? 1 : -1
        if (da && dbn && sort !== 'manual') return (b.done_at || 0) - (a.done_at || 0)
        if (sort === 'manual') {
          var oa = typeof a.order === 'number' ? a.order : null, ob = typeof b.order === 'number' ? b.order : null
          if (oa != null && ob != null && oa !== ob) return oa - ob
          if (oa != null && ob == null) return -1
          if (ob != null && oa == null) return 1
          return b.created - a.created
        }
        if (sort === 'due') return byDue(a, b) || rank[a.priority || 'normal'] - rank[b.priority || 'normal'] || b.created - a.created
        if (sort === 'priority') return rank[a.priority || 'normal'] - rank[b.priority || 'normal'] || byDue(a, b) || b.created - a.created
        if (sort === 'created') return b.created - a.created
        if (sort === 'updated') return b.updated - a.updated
        var ovA = !!(a.due && a.due < day), ovB = !!(b.due && b.due < day)
        return (stRank[a.status || 'open'] === 0) !== (stRank[b.status || 'open'] === 0) ? stRank[a.status || 'open'] - stRank[b.status || 'open']
          : ovA !== ovB ? (ovA ? -1 : 1)
          : rank[a.priority || 'normal'] - rank[b.priority || 'normal'] || byDue(a, b) || b.created - a.created
      })
      return list.map(view)
    },
  }
  window.todoStore = store

  // ---------- 给 agent 的工具（说明和参数在 plugin.json 的 tools 里） ----------
  if (typeof window.utools.registerTool !== 'function') return
  function actorOf(ctx) {
    var c = ctx && ctx.caller
    if (!c) return { by: 'agent' }
    return { by: 'agent', agent: c.agent || null, pane: c.pane == null ? null : c.pane, cwd: c.cwd || null, session: c.session || null }
  }
  function projectArg(p, ctx) {
    if (p === 'current') return (ctx && ctx.caller && ctx.caller.cwd) || ''
    return p || ''
  }
  /** 给 agent 的精简版：去掉内部字段，动态只留最近几条 */
  function brief(v, full) {
    var o = Object.assign({}, v)
    delete o.order
    o.log = full ? v.log.slice(-15) : undefined
    o.runs = full ? v.runs.slice(-3) : undefined
    if (!full) { delete o.log; delete o.runs }
    return o
  }
  var reg = window.utools.registerTool
  reg('add', function (p, ctx) {
    var actor = actorOf(ctx)
    var input = { title: p.title, note: p.note, priority: p.priority, assignee: p.assignee, due: p.due, tags: p.tags, links: p.links, project: p.project === undefined ? actor.cwd : projectArg(p.project, ctx) }
    return { added: brief(store.add(input, actor)) }
  })
  reg('list', function (p, ctx) {
    var limit = Math.max(1, Math.min(200, Number(p.limit) || 50))
    var items = store.list({ status: p.status === 'open' ? 'active' : p.status === 'not_started' ? 'open' : p.status, assignee: p.assignee, overdue: p.overdue, project: projectArg(p.project, ctx) || 'all', query: p.query, tag: p.tag })
    return { total: items.length, items: items.slice(0, limit).map(function (v) { return brief(v) }) }
  })
  reg('get', function (p) { return { item: brief(store.get(p.id), true) } })
  reg('update', function (p, ctx) {
    var patch = {}
    ;['title', 'note', 'priority', 'assignee', 'due', 'tags', 'links', 'status', 'blocker', 'project'].forEach(function (k) { if (p[k] !== undefined) patch[k] = p[k] })
    return { updated: brief(store.update(p.id, patch, actorOf(ctx))) }
  })
  reg('start', function (p, ctx) {
    var cur = store.get(p.id)
    var me = actorOf(ctx)
    if (cur.status === 'in_progress' && cur.claim && cur.claim.session && me.session && cur.claim.session !== me.session && p.force !== true) {
      return { started: false, reason: '另一个会话正在处理：' + cur.claim.agent + ' #' + cur.claim.pane + '（' + new Date(cur.claim.at).toLocaleString() + ' 开始）。确定要接手就带 force: true', item: brief(cur) }
    }
    return { started: true, item: brief(store.start(p.id, me)) }
  })
  reg('comment', function (p, ctx) {
    var item = store.comment(p.id, p.text, actorOf(ctx), p.needs_reply === true)
    // 要用户回答：推到手机（和 notify_phone 同样限频）
    if (p.needs_reply === true && window.whatevertools && whatevertools.platform && whatevertools.platform.agent) {
      return whatevertools.platform.agent.notify({ title: '等你回复', body: item.title + '：' + String(p.text).slice(0, 200) })
        .then(function (r) { return { commented: brief(item), notified: !!(r && r.sent) } }, function () { return { commented: brief(item), notified: false } })
    }
    return { commented: brief(item) }
  })
  reg('done', function (p, ctx) { return { updated: brief(store.setDone(p.id, p.reopen !== true, p.note, actorOf(ctx))) } })
  reg('remove', function (p, ctx) { return { trashed: brief(store.trash(p.id, actorOf(ctx))), note: '已放进回收站，用户可以在手机上恢复' } })
})()
