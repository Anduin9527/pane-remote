// 待办的手机界面。数据层在 preload.js（window.todoStore），这里只管画和交互。
// - 列表：状态（未完成 / 已完成 / 全部）+ 快捷筛选（等我、agent 可做、处理中、待定、已过期）+ 项目；排序、分组可选，手动排序可以拖
// - 点一条打开底部面板：回答 agent 的问题、立即执行 / 立即检查（发回记下它的会话，可以换一次）、subagent 开关（记住）、
//   处理类型、评论、编辑、完成、删除（进回收站）、动态
// - 你在这里做的操作经 platform.sessions.note 告诉记下它的会话（它下次收到你的消息时看到）
// - 「一段话」：用插件的 AI 把一段话拆成操作，确认后执行
'use strict'
;(function () {
  const store = window.todoStore
  const wt = window.whatevertools
  const platform = wt && wt.platform
  const kv = utools.dbStorage
  const lang = kv.getItem('ui.lang') // 'zh' | 'en'，不设就跟系统
  const zh = lang ? lang === 'zh' : /^zh/i.test(navigator.language || 'zh')
  const T = zh ? {
    active: '未完成', done: '已完成', all: '全部', trash: '回收站', allProjects: '全部项目', noProject: '未分项目', add: '记下', placeholder: '记一条待办…',
    aiPlaceholder: '说一段话，比如：把买牛奶那条勾掉；加一条明天前要回张三的邮件，必须我来；让 agent 检查一下登录 bug 那条', analyze: '分析', ai: '一段话（AI 分析）',
    fAll: '全部', fMine: '等我', fAgent: 'agent 可做', fProg: '处理中', fUndecided: '待定', fLate: '已过期',
    open: '未开始', in_progress: '处理中', blocked: '等你', agent: 'agent 可做', human: '必须人类', undecided: '待定',
    high: '高', normal: '普通', low: '低', title: '标题', note: '备注', priority: '优先级', type: '处理类型', status: '状态', due: '截止日期', tags: '标签（逗号分开）', links: '链接（一行一个）',
    clearDue: '不设', close: '完成', back: '返回', cancel: '取消',
    empty: { active: '没有未完成的待办', done: '还没有完成的', all: '还没有待办', trash: '回收站是空的' }, emptyFiltered: '这个筛选下没有待办',
    emptyHint: '在 pane-remote 里跑的 agent 会把要你处理的事记到这里，也可以自己在上面记。',
    added: '已记下', trashed: '已移进回收站', undo: '撤销', reopened: '已重新打开', finished: '已完成', restored: '已恢复', purged: '已彻底删除', emptied: '回收站已清空',
    more: '再显示 {n} 条', phone: '手机', created: '{t} 由 {who} 记下', doneAt: '{t} 完成', trashedAt: '{t} 删除', project: '项目',
    justNow: '刚刚', min: '{n} 分钟前', hour: '{n} 小时前', day: '{n} 天前', dueIn: '{d} 截止', dueToday: '今天截止', late: '过期 {n} 天',
    run: '立即执行', check: '立即检查', edit: '编辑', markDone: '标记完成', reopen: '重新打开', del: '删除（移进回收站）', restore: '恢复', purge: '彻底删除', confirmPurge: '再点一次彻底删除',
    emptyTrash: '清空回收站', confirmEmpty: '再点一次清空', trashHint: '删除的待办在这里放 {d} 天', comment: '评论', commentPh: '写点什么（进展、补充、要求）…',
    sendNow: '马上发给会话', sendNowHint: '不勾就等它下次收到你的消息时一起看到', post: '发表',
    asks: '{who} 问你：', replyPh: '回复…（发回给它）', reply: '回复', replied: '已回复', replyTo: '发到 {to}', replyNote: '会话不在，等它下次收到你的消息时看到',
    claim: '{who} 处理中 · {t}', sendTo: '发到', originTag: '记下它的会话', change: '换一个', pickTitle: '选一个会话', noOrigin: '记下它的会话已经不在了，选一个会话', noAgent: '没有找到在跑的 agent 会话',
    loading: '正在找会话…', subagent: '用 subagent 执行', subagentHint: '主会话只看结论，不占它的上下文（记住这个选择）',
    notOrigin: '没有这条待办的上下文', busy: '忙', send: '发送', sent: '已发到 {to}', lastRun: '上次{k} · {t} · {to}', kRun: '执行', kCheck: '检查',
    onceHint: '只这一次发到别的会话，不会记住。', permHint: '要允许「agent 会话」权限才能发给会话', humanWarn: '这条标的是「必须人类」，确定要交给 agent？', message: '要发的话（可以改）',
    activity: '动态（{n}）', view: '显示', sort: '排序', group: '分组',
    sSmart: '智能（等你、过期、优先级在前）', sDue: '截止日期', sPriority: '优先级', sCreated: '最新创建', sUpdated: '最近更新', sManual: '手动（拖动调整）',
    gProject: '按项目', gTag: '按标签', gPriority: '按优先级', gStatus: '按状态', gType: '按处理类型', gNone: '不分组', noTag: '没有标签', dragHint: '按住右边的 ≡ 拖动；拖动会切到手动排序',
    promptRun: '[待办 {id}] 请现在处理这条待办{sub}：', promptCheck: '[待办 {id}] 请检查这条待办现在的状态，只检查、先不动手{sub}：',
    subRun: '，用 subagent 去做（你只看它的结论，汇总给我）', subCheck: '，用 subagent 去查（你只看它的结论）',
    pTitle: '标题：', pNote: '备注：', pProject: '项目：', pDue: '截止：', pLinks: '链接：', pLog: '最近的动态：',
    tailRun: '开始前先调 plugin_todo_start(id="{id}")；做完用 plugin_todo_done(id="{id}", note=一句话结果)；需要我决定的用 plugin_todo_comment(id="{id}", text=问题, needs_reply=true) 问我。',
    tailCheck: '看看是不是已经做完了、还差什么、有没有卡住。结论用 plugin_todo_comment(id="{id}", text=…) 记下；已经做完的话用 plugin_todo_done(id="{id}")。',
    nDone: '用户在手机上把待办「{t}」({id}) 标记为完成了', nReopen: '用户在手机上重新打开了待办「{t}」({id})', nTrash: '用户在手机上删除了待办「{t}」({id})（在回收站里）',
    nRestore: '用户在手机上从回收站恢复了待办「{t}」({id})', nPurge: '用户在手机上彻底删除了待办「{t}」({id})', nEdit: '用户在手机上修改了待办「{t}」({id})：{f}',
    nComment: '用户在待办「{t}」({id}) 下评论：{c}', nReply: '[待办 {id}] 用户回复了你在「{t}」里的问题：{c}', nType: '用户把待办「{t}」({id}) 的处理类型改成了「{v}」', nSentOther: '用户把待办「{t}」({id}) 发给了 {to} 去{k}',
    aiWorking: '正在分析…', aiNone: '没有看出要做什么', aiApply: '执行 {n} 项', aiNoModel: 'Mac 上没有可用的 AI 模型', aiDone: '已执行 {n} 项',
    opAdd: '新建', opUpdate: '修改', opDone: '完成', opReopen: '重新打开', opTrash: '删除', opComment: '评论', opRun: '发去执行', opCheck: '发去检查', opMissing: '（找不到这条）',
  } : {
    active: 'Open', done: 'Done', all: 'All', trash: 'Trash', allProjects: 'All projects', noProject: 'No project', add: 'Add', placeholder: 'Add a todo…',
    aiPlaceholder: 'Say it in your own words, e.g.: check off the milk one; add "reply to Alex by tomorrow", I have to do it; ask an agent to check the login bug item', analyze: 'Analyze', ai: 'Free text (AI)',
    fAll: 'All', fMine: 'Needs me', fAgent: 'Agent can do', fProg: 'In progress', fUndecided: 'Undecided', fLate: 'Overdue',
    open: 'Not started', in_progress: 'In progress', blocked: 'Waiting for you', agent: 'Agent can do', human: 'Needs you', undecided: 'Undecided',
    high: 'High', normal: 'Normal', low: 'Low', title: 'Title', note: 'Note', priority: 'Priority', type: 'Who', status: 'Status', due: 'Due', tags: 'Tags (comma separated)', links: 'Links (one per line)',
    clearDue: 'None', close: 'Done', back: 'Back', cancel: 'Cancel',
    empty: { active: 'Nothing open', done: 'Nothing done yet', all: 'No todos yet', trash: 'Trash is empty' }, emptyFiltered: 'Nothing matches this filter',
    emptyHint: 'Agents running in pane-remote put things that need you here; you can add your own above.',
    added: 'Added', trashed: 'Moved to trash', undo: 'Undo', reopened: 'Reopened', finished: 'Done', restored: 'Restored', purged: 'Deleted', emptied: 'Trash emptied',
    more: 'Show {n} more', phone: 'phone', created: 'Added {t} by {who}', doneAt: 'Done {t}', trashedAt: 'Deleted {t}', project: 'Project',
    justNow: 'just now', min: '{n} min ago', hour: '{n} h ago', day: '{n} d ago', dueIn: 'due {d}', dueToday: 'due today', late: '{n} d overdue',
    run: 'Run now', check: 'Check now', edit: 'Edit', markDone: 'Mark done', reopen: 'Reopen', del: 'Delete (to trash)', restore: 'Restore', purge: 'Delete forever', confirmPurge: 'Tap again to delete forever',
    emptyTrash: 'Empty trash', confirmEmpty: 'Tap again to empty', trashHint: 'Deleted todos stay here for {d} days', comment: 'Comment', commentPh: 'Progress, details, requests…',
    sendNow: 'Send to the session now', sendNowHint: 'Otherwise it sees it with your next message', post: 'Post',
    asks: '{who} asks you:', replyPh: 'Reply… (sent back to it)', reply: 'Reply', replied: 'Replied', replyTo: 'Goes to {to}', replyNote: 'The session is gone; it sees this with your next message',
    claim: '{who} on it · {t}', sendTo: 'Send to', originTag: 'the session that added it', change: 'Change', pickTitle: 'Pick a session', noOrigin: 'The session that added it is gone; pick one', noAgent: 'No running agent session found',
    loading: 'Looking for sessions…', subagent: 'Use a subagent', subagentHint: 'The main session only sees the result (remembered)',
    notOrigin: 'has no context for this todo', busy: 'busy', send: 'Send', sent: 'Sent to {to}', lastRun: 'Last {k} · {t} · {to}', kRun: 'run', kCheck: 'check',
    onceHint: 'Sends to another session just this once; not remembered.', permHint: 'Allow the "agent sessions" permission to send to a session', humanWarn: 'This one is marked "needs you". Hand it to an agent anyway?', message: 'Message (editable)',
    activity: 'Activity ({n})', view: 'View', sort: 'Sort', group: 'Group',
    sSmart: 'Smart (waiting, overdue, priority first)', sDue: 'Due date', sPriority: 'Priority', sCreated: 'Newest', sUpdated: 'Recently updated', sManual: 'Manual (drag)',
    gProject: 'By project', gTag: 'By tag', gPriority: 'By priority', gStatus: 'By status', gType: 'By who', gNone: 'No groups', noTag: 'No tag', dragHint: 'Hold ≡ on the right to drag; dragging switches to manual order',
    promptRun: '[todo {id}] Please work on this todo now{sub}:', promptCheck: '[todo {id}] Please check where this todo stands; only check, don\'t change anything yet{sub}:',
    subRun: ', using a subagent (you only look at its result and report back)', subCheck: ', using a subagent (you only look at its result)',
    pTitle: 'Title: ', pNote: 'Note: ', pProject: 'Project: ', pDue: 'Due: ', pLinks: 'Links: ', pLog: 'Recent activity:',
    tailRun: 'Call plugin_todo_start(id="{id}") first; when done, plugin_todo_done(id="{id}", note=one-line result); ask me with plugin_todo_comment(id="{id}", text=question, needs_reply=true) if you need a decision.',
    tailCheck: 'Is it done already, what is left, is anything blocking? Record the result with plugin_todo_comment(id="{id}", text=…); if it is done, call plugin_todo_done(id="{id}").',
    nDone: 'The user marked todo "{t}" ({id}) as done on their phone', nReopen: 'The user reopened todo "{t}" ({id})', nTrash: 'The user deleted todo "{t}" ({id}) (it is in the trash)',
    nRestore: 'The user restored todo "{t}" ({id}) from the trash', nPurge: 'The user permanently deleted todo "{t}" ({id})', nEdit: 'The user edited todo "{t}" ({id}): {f}',
    nComment: 'The user commented on todo "{t}" ({id}): {c}', nReply: '[todo {id}] The user answered your question in "{t}": {c}', nType: 'The user set todo "{t}" ({id}) to "{v}"', nSentOther: 'The user sent todo "{t}" ({id}) to {to} to {k}',
    aiWorking: 'Analyzing…', aiNone: 'Nothing to do found', aiApply: 'Apply {n}', aiNoModel: 'No AI model available on the Mac', aiDone: 'Applied {n}',
    opAdd: 'Add', opUpdate: 'Edit', opDone: 'Done', opReopen: 'Reopen', opTrash: 'Delete', opComment: 'Comment', opRun: 'Run', opCheck: 'Check', opMissing: ' (not found)',
  }
  const PHONE = { by: 'phone' }
  const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => (o[k] == null ? '' : o[k]))
  const $ = (id) => document.getElementById(id)
  const el = (tag, attrs, ...kids) => {
    const e = document.createElement(tag)
    for (const k in attrs || {}) { const v = attrs[k]; if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v) }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c))
    return e
  }
  const svg = (d, extra) => { const s = document.createElement('span'); s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${d}</svg>`; return s.firstChild }
  const I = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>', play: '<path d="M7 4v16l13-8z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>', undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', list: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    sort: '<path d="M4 6h16M7 12h10M10 18h4"/>', grip: '<path d="M5 9h14M5 15h14"/>', chat: '<path d="M4 5h16v11H8l-4 4z"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  }
  const tilde = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 60) return T.justNow
    if (s < 3600) return fmt(T.min, { n: Math.round(s / 60) })
    if (s < 86400) return fmt(T.hour, { n: Math.round(s / 3600) })
    if (s < 86400 * 30) return fmt(T.day, { n: Math.round(s / 86400) })
    return new Date(t).toLocaleDateString()
  }
  const who = (src) => !src || src.by === 'phone' ? T.phone : src.agent ? (src.pane != null ? `${src.agent} · #${src.pane}` : src.agent) : 'agent'
  const sessName = (s) => `${s.agent} · #${s.pane}`
  const dueText = (d) => {
    if (!d.due) return null
    if (d.overdue) return el('span', { class: 'pill late' }, fmt(T.late, { n: Math.max(1, Math.round((Date.parse(store.today()) - Date.parse(d.due)) / 86400000)) }))
    return el('span', null, d.due === store.today() ? T.dueToday : fmt(T.dueIn, { d: d.due.slice(0, 4) === store.today().slice(0, 4) ? d.due.slice(5) : d.due }))
  }

  // ---------- 状态（筛选、排序、分组、subagent 选项记在 dbStorage 里，换手机、重开都在） ----------
  let status = kv.getItem('ui.status') || 'active'
  if (status === 'open') status = 'active'
  let filter = kv.getItem('ui.filter') || ''
  let project = kv.getItem('ui.project') || ''
  let sort = kv.getItem('ui.sort') || 'smart'
  let groupBy = kv.getItem('ui.group') || 'project'
  let limit = 150, armedEmpty = false, aiMode = false
  const setKv = (k, v) => kv.setItem(k, v)

  for (const b of $('status').children) b.textContent = T[b.dataset.v]
  $('trashBtn').append(svg(I.trash), el('span', { class: 'badge', id: 'trashCount', hidden: true }))
  $('trashBtn').setAttribute('aria-label', T.trash)
  $('viewBtn').append(svg(I.sort))
  $('viewBtn').setAttribute('aria-label', T.view)
  $('aiBtn').append(svg(I.spark))
  $('aiBtn').setAttribute('aria-label', T.ai)
  $('addInput').placeholder = T.placeholder
  $('aiInput').placeholder = T.aiPlaceholder
  $('addBtn').textContent = T.add
  $('trashHint').textContent = fmt(T.trashHint, { d: store.TRASH_DAYS })

  // ---------- 提示条（带撤销） ----------
  let toastTimer
  function toast(msg, undo) {
    const t = $('toast'), btn = t.querySelector('button')
    t.querySelector('span').textContent = msg
    btn.hidden = !undo
    btn.textContent = T.undo
    btn.onclick = () => { t.classList.remove('on'); undo && undo() }
    t.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('on'), undo ? 5000 : 2400)
  }
  function attempt(fn) { try { return fn() } catch (e) { toast(e.message); console.warn(e) } }

  // ---------- agent 会话（platform.sessions，第一次用时问「agent 会话」权限） ----------
  let sessions = null, sessionsAt = 0, sessionsErr = ''
  async function loadSessions(force) {
    if (!platform || !platform.sessions) { sessionsErr = 'unsupported'; sessions = []; return sessions }
    if (!force && sessions && Date.now() - sessionsAt < 10000) return sessions
    try { sessions = await platform.sessions.list(); sessionsAt = Date.now(); sessionsErr = ''; backfill(sessions) }
    catch (e) { sessionsErr = e.code === 'EWTPERM' ? T.permHint : e.message; sessions = sessions || [] }
    return sessions
  }
  /** 记下这条待办的会话现在在哪：有会话 id 按 id 找；老的只有 pane，按 pane + agent + 会话开始得比待办早来认 */
  function originOf(d, list) {
    const src = d.source || {}
    if (src.by !== 'agent' || !list) return null
    if (src.session) return list.find((s) => s.session === src.session) || null
    return list.find((s) => s.pane === src.pane && s.agent === src.agent && (!s.startedAt || s.startedAt <= d.created)) || null
  }
  /** 正在处理它的会话（认领的），没有就是记下它的 */
  function ownerOf(d, list) {
    if (d.claim && d.claim.session && list) { const s = list.find((x) => x.session === d.claim.session); if (s) return s }
    return originOf(d, list)
  }
  /** 老待办补上会话 id（只记了 pane 的） */
  function backfill(list) {
    for (const d of store.list({ status: 'all' }).concat(store.list({ status: 'trash' }))) {
      if (d.source && d.source.by === 'agent' && !d.source.session) { const s = originOf(d, list); if (s && s.session) attempt(() => store.setSession(d.id, s.session)) }
    }
  }
  /** 告诉记下它（或正在处理它）的会话：你在手机上做了什么。它下次收到你的消息时（或调 pane-remote 工具时）看到，不打断它 */
  function noteSession(d, key, extra) {
    const targets = new Set([d.source && d.source.by === 'agent' && d.source.session, d.claim && d.claim.session].filter(Boolean))
    if (!targets.size || !platform || !platform.sessions) return
    const text = fmt(T[key], Object.assign({ t: d.title, id: d.id }, extra || {}))
    for (const s of targets) platform.sessions.note({ session: s, text }).catch((e) => console.warn('[todo] note', e.message))
  }
  /** 直接发给会话（回复它的问题、马上要它看到的评论）；会话不在就留言 */
  async function tellNow(d, text) {
    const list = await loadSessions(true)
    const s = ownerOf(d, list)
    if (s) { await platform.sessions.send(s.session ? { session: s.session, text } : { pane: s.pane, text }); return s }
    noteSessionText(d, text)
    return null
  }
  function noteSessionText(d, text) {
    const targets = new Set([d.source && d.source.by === 'agent' && d.source.session, d.claim && d.claim.session].filter(Boolean))
    for (const s of targets) platform && platform.sessions && platform.sessions.note({ session: s, text }).catch(() => {})
  }

  // ---------- 列表 ----------
  const FILTERS = [
    ['', 'fAll', () => true],
    ['mine', 'fMine', (d) => d.status === 'blocked' || d.assignee === 'human'],
    ['agent', 'fAgent', (d) => d.assignee === 'agent' && d.status !== 'in_progress'],
    ['prog', 'fProg', (d) => d.status === 'in_progress'],
    ['undecided', 'fUndecided', (d) => d.assignee === 'undecided'],
    ['late', 'fLate', (d) => d.overdue],
  ]
  const filterFn = () => (FILTERS.find((f) => f[0] === filter) || FILTERS[0])[2]
  let pendingRender = false
  function render() {
    const focus = document.activeElement
    if (focus && focus.closest && focus.closest('.sheet') && /INPUT|TEXTAREA|SELECT/.test(focus.tagName)) { pendingRender = true; return }
    if (dragging) { pendingRender = true; return }
    pendingRender = false
    const trashMode = status === 'trash'
    for (const b of $('status').children) b.setAttribute('aria-pressed', String(b.dataset.v === status))
    $('trashBtn').setAttribute('aria-pressed', String(trashMode))
    const nTrash = store.list({ status: 'trash' }).length
    $('trashCount').hidden = !nTrash || trashMode
    $('trashCount').textContent = nTrash
    $('addForm').hidden = trashMode
    $('trashBar').hidden = !trashMode || !nTrash
    $('emptyBtn').textContent = armedEmpty ? T.confirmEmpty : T.emptyTrash
    $('emptyBtn').className = armedEmpty ? 'armed' : ''

    const base = store.list({ status, sort })
    // 快捷筛选（在「未完成」「全部」里有用）
    const fChips = $('filters')
    if (trashMode || status === 'done') { fChips.hidden = true } else {
      fChips.hidden = false
      fChips.replaceChildren(...FILTERS.map(([k, label, fn]) => {
        const n = k ? base.filter(fn).length : base.length
        if (k && !n && filter !== k) return null
        return el('button', { class: 'chip' + (k === 'late' || k === 'mine' ? ' warn' : ''), 'aria-pressed': String(filter === k), onclick: () => { filter = k; setKv('ui.filter', k); render() } }, T[label], el('small', null, n))
      }).filter(Boolean))
    }
    const filtered = trashMode || status === 'done' ? base : base.filter(filterFn())
    // 项目
    const counts = new Map()
    for (const d of filtered) counts.set(d.project || '', (counts.get(d.project || '') || 0) + 1)
    if (project && !filtered.some((d) => d.project === project || String(d.project).startsWith(project + '/'))) project = ''
    const chips = $('projects')
    chips.replaceChildren(
      el('button', { class: 'chip', 'aria-pressed': String(!project), onclick: () => setProject('') }, T.allProjects),
      ...[...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b)).filter((p) => p).map((p) =>
        el('button', { class: 'chip', 'aria-pressed': String(project === p), title: p, onclick: () => setProject(p) }, store.base(p), el('small', null, counts.get(p)))),
    )
    chips.hidden = counts.size < 2 && !project
    const items = project ? filtered.filter((d) => d.project === project || String(d.project).startsWith(project + '/')) : filtered
    const list = $('list')
    if (!items.length) {
      list.replaceChildren(el('div', { class: 'empty' }, svg(trashMode ? I.trash : I.list, 'stroke-width="1.6"'), el('div', null, filter && !trashMode ? T.emptyFiltered : T.empty[status]), trashMode || filter ? null : el('p', null, T.emptyHint)))
      return renderSheet()
    }
    const shown = items.slice(0, limit)
    const out = []
    for (const [key, label, sub, ds] of groups(shown)) {
      if (label != null) out.push(el('div', { class: 'group' }, el('b', null, label), sub ? el('span', null, sub) : null, el('i', null, ds.length)))
      out.push(el('ul', { 'data-group': key }, ds.map(item)))
    }
    if (items.length > limit) out.push(el('button', { class: 'more', onclick: () => { limit += 150; render() } }, fmt(T.more, { n: items.length - limit })))
    list.replaceChildren(...out)
    renderSheet()
  }
  /** 分组：[键, 标题（null = 不显示）, 副标题, 条目] */
  function groups(items) {
    const g = new Map()
    const put = (k, label, sub, d) => { if (!g.has(k)) g.set(k, [k, label, sub, []]); g.get(k)[3].push(d) }
    const mode = status === 'trash' ? 'none' : project && groupBy === 'project' ? 'none' : groupBy
    for (const d of items) {
      if (mode === 'project') put('p:' + d.project, d.project ? store.base(d.project) : T.noProject, d.project ? tilde(d.project) : '', d)
      else if (mode === 'tag') { if (!d.tags.length) put('t:', T.noTag, '', d); else put('t:' + d.tags[0], '#' + d.tags[0], '', d) }
      else if (mode === 'priority') put('r:' + d.priority, T[d.priority], '', d)
      else if (mode === 'status') put('s:' + d.status, T[d.status] || T.done, '', d)
      else if (mode === 'type') put('a:' + d.assignee, T[d.assignee], '', d)
      else put('', null, '', d)
    }
    const order = { priority: ['r:high', 'r:normal', 'r:low'], status: ['s:blocked', 's:in_progress', 's:open', 's:done'], type: ['a:human', 'a:agent', 'a:undecided'] }[mode]
    const list = [...g.values()]
    if (order) list.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    // 只有一组而且是「未分项目」这类：不显示标题
    if (list.length === 1 && (mode === 'none' || (mode === 'project' && !items[0].project))) list[0][1] = null
    return list
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender) render() }))

  function lastRun(d) {
    const r = d.runs[d.runs.length - 1]
    return r ? fmt(T.lastRun, { k: r.kind === 'check' ? T.kCheck : T.kRun, t: ago(r.at), to: `${r.agent} · #${r.pane}` }) : ''
  }
  function statusPill(d) {
    if (d.status === 'in_progress') return el('span', { class: 'pill prog' }, d.claim ? `${T.in_progress} · ${d.claim.agent || 'agent'}${d.claim.pane != null ? ' #' + d.claim.pane : ''}` : T.in_progress)
    if (d.status === 'blocked') return el('span', { class: 'pill wait' }, T.blocked)
    return null
  }
  function item(d) {
    const cls = d.status === 'in_progress' ? ' prog' : d.status === 'blocked' ? ' wait' : d.priority === 'high' && d.status === 'open' ? ' high' : ''
    const check = el('button', { class: 'check' + cls, 'aria-label': d.status === 'done' ? T.reopen : T.markDone, onclick: () => toggle(d) })
    check.append(svg(I.check, 'stroke="#fff" stroke-width="3.5"'))
    const meta = el('div', { class: 'meta' },
      statusPill(d),
      d.assignee === 'human' && d.status !== 'done' ? el('span', null, '👤 ' + T.human) : d.assignee === 'agent' && d.status === 'open' ? el('span', null, '🤖 ' + T.agent) : null,
      d.priority === 'high' ? el('span', { class: 'p-high' }, T.high) : d.priority === 'low' ? el('span', null, T.low) : null,
      d.status !== 'done' ? dueText(d) : null,
      d.tags.map((t) => el('span', { class: 'tag' }, '#' + t)),
      el('span', null, who(d.source)),
      el('span', null, ago(d.trashed_at || (d.status === 'done' && d.done_at) || d.created)),
    )
    const li = el('li', { class: d.trashed_at ? 'trashed' : d.status === 'done' ? 'done' : '', 'data-id': d.id },
      el('div', { class: 'row' }, check,
        el('button', { class: 'body', onclick: () => openSheet(d.id) },
          el('div', { class: 'title' }, d.title),
          d.status === 'blocked' && d.blocker ? el('div', { class: 'ask-line' }, '? ' + d.blocker) : d.note ? el('div', { class: 'note' }, d.note.split('\n')[0]) : null,
          meta),
        sort === 'manual' && !d.trashed_at ? handle() : null))
    return li
  }

  // ---------- 拖动排序（只在手动排序时显示把手；第一次拖时按当前顺序编号） ----------
  let dragging = null
  function handle() {
    const h = el('div', { class: 'handle', 'aria-hidden': 'true' }, svg(I.grip))
    h.addEventListener('pointerdown', startDrag)
    return h
  }
  function startDrag(e) {
    const hd = e.currentTarget // 指针捕获在把手上：之后的事件都发给它（不是里面的 svg）
    const li = hd.closest('li'), ul = li.parentElement
    e.preventDefault()
    hd.setPointerCapture(e.pointerId)
    const rows = [...ul.children]
    const start = e.clientY
    const h = li.getBoundingClientRect().height
    dragging = { li, ul, rows, from: rows.indexOf(li), to: rows.indexOf(li) }
    li.classList.add('dragging')
    const move = (ev) => {
      const dy = ev.clientY - start
      li.style.transform = `translateY(${dy}px)`
      const to = Math.max(0, Math.min(rows.length - 1, dragging.from + Math.round(dy / h)))
      dragging.to = to
      rows.forEach((r, i) => {
        if (r === li) return
        const shift = dragging.from < to ? (i > dragging.from && i <= to ? -h : 0) : (i < dragging.from && i >= to ? h : 0)
        r.style.transition = 'transform .12s'
        r.style.transform = shift ? `translateY(${shift}px)` : ''
      })
    }
    const up = () => {
      hd.removeEventListener('pointermove', move)
      hd.removeEventListener('pointerup', up)
      hd.removeEventListener('pointercancel', up)
      const { from, to } = dragging
      rows.forEach((r) => { r.style.transform = ''; r.style.transition = '' })
      li.classList.remove('dragging')
      dragging = null
      if (from !== to) {
        const ids = rows.map((r) => r.dataset.id)
        const moved = ids.splice(from, 1)[0]
        ids.splice(to, 0, moved)
        // 还没编过号（或者有的没有）：先按现在看到的顺序编号
        const all = [...document.querySelectorAll('#list li[data-id]')].map((r) => r.dataset.id)
        if (all.some((id) => attempt(() => store.get(id).order) == null)) attempt(() => store.seedOrder(all))
        attempt(() => store.move(moved, ids[to - 1] || null, ids[to + 1] || null))
      }
      render()
    }
    hd.addEventListener('pointermove', move)
    hd.addEventListener('pointerup', up)
    hd.addEventListener('pointercancel', up)
  }

  function toggle(d) {
    const done = d.status !== 'done'
    if (!attempt(() => store.setDone(d.id, done, '', PHONE))) return
    noteSession(d, done ? 'nDone' : 'nReopen')
    render()
    toast(done ? T.finished : T.reopened, () => { attempt(() => store.setDone(d.id, !done, '', PHONE)); noteSession(d, done ? 'nReopen' : 'nDone'); render() })
  }
  function trash(d) {
    if (!attempt(() => store.trash(d.id, PHONE))) return
    noteSession(d, 'nTrash')
    closeSheet()
    render()
    toast(T.trashed, () => { attempt(() => store.restore(d.id, PHONE)); noteSession(d, 'nRestore'); render() })
  }
  function setProject(p) { project = p; setKv('ui.project', p); limit = 150; render() }
  for (const b of $('status').children) b.onclick = () => setStatus(b.dataset.v)
  $('trashBtn').onclick = () => setStatus(status === 'trash' ? 'active' : 'trash')
  $('viewBtn').onclick = () => openSheet(null, 'view')
  function setStatus(v) { status = v; setKv('ui.status', v); limit = 150; armedEmpty = false; render() }
  $('emptyBtn').onclick = () => {
    if (!armedEmpty) { armedEmpty = true; render(); setTimeout(() => { if (armedEmpty) { armedEmpty = false; render() } }, 4000); return }
    armedEmpty = false
    const gone = store.list({ status: 'trash' })
    const n = attempt(() => store.emptyTrash())
    for (const d of gone) noteSession(d, 'nPurge')
    render()
    if (n != null) toast(T.emptied)
  }

  // ---------- 底部面板 ----------
  // mode：actions、edit、send（确认要发的话）、pick（选会话，只这一次）、view（排序 / 分组）、ai（一段话的分析结果）
  let sheet = null
  function openSheet(id, mode) {
    document.activeElement && document.activeElement.blur && document.activeElement.blur()
    sheet = { id, mode: mode || 'actions', target: null, armed: false }
    $('shade').classList.add('on')
    $('sheet').classList.add('on')
    document.body.classList.add('locked')
    renderSheet()
    if (id) loadSessions().then(renderSheet)
  }
  function closeSheet() {
    if (sheet && sheet.mode === 'edit') finishEdit()
    sheet = null
    $('shade').classList.remove('on')
    $('sheet').classList.remove('on')
    document.body.classList.remove('locked')
    if (pendingRender) setTimeout(render)
  }
  $('shade').onclick = closeSheet
  function current() { try { return sheet && sheet.id && store.get(sheet.id) } catch (e) { return null } }

  function renderSheet() {
    const box = $('sheet')
    if (!sheet) return
    const focus = document.activeElement
    if (focus && box.contains(focus) && /INPUT|TEXTAREA|SELECT/.test(focus.tagName)) return
    const kids = [el('div', { class: 'grab' })]
    if (sheet.mode === 'view') kids.push(...viewSheet())
    else if (sheet.mode === 'ai') kids.push(...aiSheet())
    else {
      const d = current()
      if (!d) { closeSheet(); return }
      if (sheet.mode === 'actions') kids.push(...actionsView(d))
      else if (sheet.mode === 'edit') kids.push(...editView(d))
      else if (sheet.mode === 'send') kids.push(...sendView(d))
      else if (sheet.mode === 'pick') kids.push(...pickView(d))
    }
    box.replaceChildren(...kids.filter(Boolean))
  }

  function viewSheet() {
    const opt = (cur, v, label, set) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: () => { set(v); render() } }, label, cur === v ? '✓' : '')
    return [
      el('div', { class: 's-head' }, el('span'), el('b', null, T.view), el('button', { type: 'button', onclick: closeSheet }, T.close)),
      el('div', { class: 'sect' }, T.sort),
      el('div', { class: 'opt-list' }, [['smart', T.sSmart], ['due', T.sDue], ['priority', T.sPriority], ['created', T.sCreated], ['updated', T.sUpdated], ['manual', T.sManual]].map(([v, l]) => opt(sort, v, l, (x) => { sort = x; setKv('ui.sort', x) }))),
      el('div', { class: 'hint' }, T.dragHint),
      el('div', { class: 'sect' }, T.group),
      el('div', { class: 'opt-list' }, [['project', T.gProject], ['tag', T.gTag], ['priority', T.gPriority], ['status', T.gStatus], ['type', T.gType], ['none', T.gNone]].map(([v, l]) => opt(groupBy, v, l, (x) => { groupBy = x; setKv('ui.group', x) }))),
    ]
  }

  function infoLine(d) {
    const info = [fmt(T.created, { t: new Date(d.created).toLocaleString(), who: who(d.source) })]
    if (d.done_at && d.status === 'done') info.push(fmt(T.doneAt, { t: ago(d.done_at) }))
    if (d.trashed_at) info.push(fmt(T.trashedAt, { t: ago(d.trashed_at) }))
    if (d.project) info.push(`${T.project}：${tilde(d.project)}`)
    const ran = lastRun(d)
    if (ran) info.push(ran)
    return el('div', { class: 's-meta' }, info.join(' · '))
  }
  function targetOf(d) {
    if (sheet.target) return { s: sheet.target, origin: false }
    const o = sessions ? originOf(d, sessions) : null
    return o ? { s: o, origin: true } : null
  }
  function targetLine(d) {
    const t = targetOf(d)
    let text
    if (!sessions) text = el('div', { class: 't' }, T.loading)
    else if (sessionsErr && !sessions.length) text = el('div', { class: 't warn' }, sessionsErr)
    else if (!t) text = el('div', { class: 't warn' }, sessions.length ? T.noOrigin : T.noAgent)
    else text = el('div', { class: 't' }, `${T.sendTo} `, el('b', null, sessName(t.s)), t.origin ? `（${T.originTag}）` : '', el('small', null, tilde(t.s.cwd) + (t.s.status === 'busy' ? ` · ${T.busy}` : '')))
    return el('div', { class: 'target' }, text, sessions && sessions.length ? el('button', { type: 'button', onclick: () => { sheet.back = sheet.mode; sheet.mode = 'pick'; renderSheet(); loadSessions(true).then(renderSheet) } }, T.change) : null)
  }
  function subagentSwitch() {
    const on = !!kv.getItem('ui.subagent')
    return el('div', { class: 'switch' }, el('div', null, T.subagent, el('small', null, T.subagentHint)),
      el('button', { type: 'button', class: 'tog', role: 'switch', 'aria-checked': String(on), 'aria-label': T.subagent, onclick: () => {
        setKv('ui.subagent', !on)
        if (sheet.mode === 'send') sheet.prompt = buildPrompt(current(), sheet.kind, !on)
        renderSheet()
      } }))
  }
  function segRow(label, values, cur, onPick) {
    return el('div', { class: 'kv' }, el('span', null, label), el('div', { class: 'seg' }, values.map((v) => el('button', { type: 'button', 'aria-pressed': String(cur === v), onclick: () => onPick(v) }, T[v]))))
  }

  function actionsView(d) {
    const out = [el('div', { class: 's-title' }, d.title)]
    const badges = el('div', { class: 's-badges' }, statusPill(d), d.status !== 'done' ? dueText(d) : null, d.priority === 'high' ? el('span', { class: 'pill late' }, T.high) : null, d.tags.map((t) => el('span', { class: 'meta' }, el('span', { class: 'tag' }, '#' + t))))
    if (badges.childNodes.length) out.push(badges)
    if (d.claim && d.status === 'in_progress') out.push(el('div', { class: 's-meta' }, fmt(T.claim, { who: `${d.claim.agent || 'agent'}${d.claim.pane != null ? ' #' + d.claim.pane : ''}`, t: ago(d.claim.at) })))
    if (d.note) out.push(el('div', { class: 's-note' }, d.note))
    if (d.links.length) out.push(el('div', { class: 's-links' }, d.links.map((l) => /^https?:\/\//.test(l) ? el('a', { href: l, onclick: (e) => { e.preventDefault(); utools.shellOpenExternal(l) } }, l) : el('div', { class: 's-meta' }, l))))
    out.push(infoLine(d))
    if (d.trashed_at) {
      const purge = el('button', { type: 'button', class: 'danger' + (sheet.armed ? ' armed' : ''), onclick: () => {
        if (!sheet.armed) { sheet.armed = true; renderSheet(); return }
        if (attempt(() => store.purge(d.id))) { noteSession(d, 'nPurge'); closeSheet(); render(); toast(T.purged) }
      } }, svg(I.x), sheet.armed ? T.confirmPurge : T.purge)
      out.push(el('div', { class: 'list-btns' },
        el('button', { type: 'button', onclick: () => { if (attempt(() => store.restore(d.id, PHONE))) { noteSession(d, 'nRestore'); closeSheet(); render(); toast(T.restored) } } }, svg(I.undo), T.restore),
        purge))
      return out
    }
    // agent 在等你回答
    if (d.status === 'blocked' && d.blocker) {
      const q = [...d.log].reverse().find((e) => e.kind === 'question' || e.kind === 'status')
      const ta = el('textarea', { placeholder: T.replyPh, maxlength: 2000, oninput: (e) => { sheet.reply = e.target.value } })
      ta.value = sheet.reply || ''
      const owner = sessions ? ownerOf(d, sessions) : null
      out.push(el('div', { class: 'askbox' },
        el('div', { class: 'q' }, el('b', null, fmt(T.asks, { who: q && q.by === 'agent' ? q.who : 'agent' })), ' ', d.blocker),
        ta,
        el('div', { class: 'row2' }, el('span', null, owner ? fmt(T.replyTo, { to: sessName(owner) }) : sessions ? T.replyNote : ''), el('button', { type: 'button', onclick: () => sendReply(d) }, T.reply))))
    }
    if (d.status !== 'done') out.push(
      el('div', { class: 'big' },
        el('button', { type: 'button', class: 'run', onclick: () => startSend(d, 'run') }, svg(I.play), T.run),
        el('button', { type: 'button', class: 'chk', onclick: () => startSend(d, 'check') }, svg(I.search), T.check)),
      targetLine(d),
      subagentSwitch(),
    )
    out.push(segRow(T.type, ['agent', 'human', 'undecided'], d.assignee, (v) => {
      if (v === d.assignee) return
      if (attempt(() => store.update(d.id, { assignee: v }, PHONE))) { noteSession(d, 'nType', { v: T[v] }); render() }
    }))
    if (sheet.commenting) {
      const ta = el('textarea', { placeholder: T.commentPh, maxlength: 2000, oninput: (e) => { sheet.comment = e.target.value } })
      ta.value = sheet.comment || ''
      const now = el('button', { type: 'button', class: 'tog', role: 'switch', 'aria-checked': String(!!sheet.commentNow), onclick: () => { sheet.commentNow = !sheet.commentNow; renderSheet() } })
      out.push(el('div', { class: 'field' }, T.comment, ta), el('div', { class: 'switch' }, el('div', null, T.sendNow, el('small', null, T.sendNowHint)), now),
        el('div', { class: 'foot' }, el('button', { type: 'button', onclick: () => { sheet.commenting = false; renderSheet() } }, T.cancel), el('button', { type: 'button', class: 'primary', onclick: () => postComment(d) }, T.post)))
    }
    out.push(el('div', { class: 'list-btns' },
      sheet.commenting ? null : el('button', { type: 'button', onclick: () => { sheet.commenting = true; renderSheet(); setTimeout(() => $('sheet').querySelector('.field textarea')?.focus(), 50) } }, svg(I.chat), T.comment),
      el('button', { type: 'button', onclick: () => { sheet.mode = 'edit'; sheet.snapshot = d; renderSheet() } }, svg(I.edit), T.edit),
      el('button', { type: 'button', onclick: () => { toggle(d); closeSheet() } }, svg(I.done), d.status === 'done' ? T.reopen : T.markDone),
      el('button', { type: 'button', class: 'danger', onclick: () => trash(d) }, svg(I.trash), T.del)))
    out.push(timeline(d))
    return out
  }

  function timeline(d) {
    const box = el('div', { class: 'timeline' })
    const evs = d.log.slice().reverse()
    box.append(el('button', { type: 'button', onclick: () => { sheet.showLog = !sheet.showLog; renderSheet() } }, (sheet.showLog ? '▾ ' : '▸ ') + fmt(T.activity, { n: evs.length })))
    if (sheet.showLog) for (const e of evs) {
      box.append(el('div', { class: 'ev ' + e.kind }, el('div', { class: 'when' }, ago(e.at)), el('div', { class: 'what' }, el('b', null, e.who), ' ', evText(e))))
    }
    return box
  }
  function evText(e) {
    const k = { created: zh ? '记下' : 'added', status: '', edit: zh ? '修改：' : 'edited: ', comment: zh ? '评论：' : 'commented: ', question: zh ? '提问：' : 'asked: ', reply: zh ? '回复：' : 'replied: ', run: '', trash: zh ? '删除' : 'deleted', restore: zh ? '恢复' : 'restored' }[e.kind]
    return (k == null ? e.kind + ' ' : k) + (e.text || '')
  }

  async function sendReply(d) {
    const text = String(sheet.reply || '').trim()
    if (!text) return
    if (!attempt(() => store.reply(d.id, text, PHONE))) return
    sheet.reply = ''
    try {
      const s = await tellNow(d, fmt(T.nReply, { id: d.id, t: d.title, c: text }))
      toast(s ? fmt(T.sent, { to: sessName(s) }) : T.replied)
    } catch (e) { noteSessionText(d, fmt(T.nReply, { id: d.id, t: d.title, c: text })); toast(e.code === 'EWTPERM' ? T.permHint : e.message) }
    render()
  }
  async function postComment(d) {
    const text = String(sheet.comment || '').trim()
    if (!text) return
    if (!attempt(() => store.comment(d.id, text, PHONE, false))) return
    const msg = fmt(T.nComment, { t: d.title, id: d.id, c: text })
    const now = !!sheet.commentNow
    sheet.comment = ''
    sheet.commenting = false
    if (now) { try { const s = await tellNow(d, msg); if (s) toast(fmt(T.sent, { to: sessName(s) })) } catch (e) { noteSessionText(d, msg); toast(e.message) } }
    else noteSessionText(d, msg)
    render()
  }

  // ---------- 发给会话执行 / 检查 ----------
  function buildPrompt(d, kind, sub) {
    const lines = [fmt(kind === 'check' ? T.promptCheck : T.promptRun, { id: d.id, sub: sub ? (kind === 'check' ? T.subCheck : T.subRun) : '' }), T.pTitle + d.title]
    if (d.note) lines.push(T.pNote + d.note)
    if (d.project) lines.push(T.pProject + d.project)
    if (d.due) lines.push(T.pDue + d.due)
    if (d.links.length) lines.push(T.pLinks + d.links.join(' '))
    const recent = d.log.filter((e) => ['comment', 'question', 'reply'].includes(e.kind)).slice(-4)
    if (recent.length) lines.push(T.pLog, ...recent.map((e) => `- ${e.who}：${evText(e)}`))
    lines.push('', fmt(kind === 'check' ? T.tailCheck : T.tailRun, { id: d.id }))
    return lines.join('\n')
  }
  function startSend(d, kind) {
    if (kind === 'run' && d.assignee === 'human' && !sheet.humanOk) { sheet.humanOk = true; toast(T.humanWarn); return }
    sheet.mode = 'send'
    sheet.kind = kind
    sheet.prompt = buildPrompt(d, kind, !!kv.getItem('ui.subagent'))
    renderSheet()
  }
  function sendView(d) {
    const t = targetOf(d)
    const ta = el('textarea', { class: 'prompt', maxlength: 8000, oninput: (e) => { sheet.prompt = e.target.value } })
    ta.value = sheet.prompt
    const btn = el('button', { type: 'button', class: 'primary', disabled: !t || sheet.sending ? true : null, onclick: () => send(d) }, sheet.sending ? el('span', { class: 'spin' }) : T.send)
    return [
      el('div', { class: 's-head' }, el('button', { type: 'button', onclick: () => { sheet.mode = 'actions'; renderSheet() } }, T.back), el('b', null, sheet.kind === 'check' ? T.check : T.run), el('span')),
      targetLine(d),
      subagentSwitch(),
      el('label', { class: 'field' }, T.message, ta),
      el('div', { class: 'foot' }, el('button', { type: 'button', onclick: closeSheet }, T.cancel), btn),
    ]
  }
  /** 发给会话，记下来；发给的不是记下它的会话时也告诉原来那个 */
  async function dispatch(d, kind, t, text) {
    const r = await platform.sessions.send(t.s.session ? { session: t.s.session, text } : { pane: t.s.pane, text })
    attempt(() => store.addRun(d.id, { kind, at: Date.now(), pane: r.pane, agent: r.agent, session: r.session || null, subagent: !!kv.getItem('ui.subagent'), origin: t.origin }))
    if (!t.origin) noteSession(d, 'nSentOther', { to: `${r.agent} · #${r.pane}`, k: kind === 'check' ? T.kCheck : T.kRun })
    return r
  }
  async function send(d) {
    const t = targetOf(d)
    if (!t || sheet.sending) return
    sheet.sending = true
    renderSheet()
    try {
      const r = await dispatch(d, sheet.kind, t, sheet.prompt)
      closeSheet()
      render()
      toast(fmt(T.sent, { to: `${r.agent} · #${r.pane}` }))
    } catch (e) {
      if (sheet) sheet.sending = false
      toast(e.code === 'EWTPERM' ? T.permHint : e.message)
      renderSheet()
    }
  }

  function pickView(d) {
    const origin = sessions ? originOf(d, sessions) : null
    const same = (a, b) => a && b && a.pane === b.pane && a.session === b.session
    const list = (sessions || []).slice().sort((a, b) => {
      const rank = (s) => (same(s, origin) ? 0 : d.project && (s.cwd === d.project || String(s.cwd).indexOf(d.project + '/') === 0) ? 1 : 2)
      return rank(a) - rank(b) || a.pane - b.pane
    })
    const pick = (s) => { sheet.target = same(s, origin) ? null : s; sheet.mode = sheet.back || 'actions'; renderSheet() }
    return [
      el('div', { class: 's-head' }, el('button', { type: 'button', onclick: () => { sheet.mode = sheet.back || 'actions'; renderSheet() } }, T.back), el('b', null, T.pickTitle), el('span')),
      !sessions ? el('div', { class: 'hint' }, T.loading) : !list.length ? el('div', { class: 'hint' }, sessionsErr || T.noAgent) : null,
      el('div', { class: 'pick' }, list.map((s) => el('button', { type: 'button', onclick: () => pick(s) },
        el('b', null, sessName(s)), ' ', el('span', { class: s.status === 'busy' ? 'busy' : '' }, s.status === 'busy' ? T.busy : ''),
        el('small', null, (s.title ? s.title + ' · ' : '') + tilde(s.cwd)),
        el('small', { class: same(s, origin) ? 'origin' : '' }, same(s, origin) ? T.originTag : T.notOrigin)))),
      el('div', { class: 'hint' }, T.onceHint),
    ]
  }

  // ---------- 编辑 ----------
  function editView(d) {
    const save = (patch) => attempt(() => store.update(d.id, patch, PHONE))
    const title = el('input', { value: d.title, maxlength: 200, onchange: (e) => { const v = e.target.value.trim(); if (v) save({ title: v }); else e.target.value = d.title } })
    const note = el('textarea', { maxlength: 4000, onchange: (e) => save({ note: e.target.value }) })
    note.value = d.note
    const seg = (field, values) => el('div', { class: 'seg' }, values.map((v) => el('button', { type: 'button', 'aria-pressed': String(d[field] === v), onclick: () => { save({ [field]: v }); renderSheet() } }, T[v])))
    const due = el('input', { type: 'date', value: d.due || '', onchange: (e) => save({ due: e.target.value || null }) })
    const tags = el('input', { value: d.tags.join(', '), onchange: (e) => save({ tags: e.target.value }) })
    const links = el('textarea', { maxlength: 5000, onchange: (e) => save({ links: e.target.value.split('\n') }) })
    links.value = d.links.join('\n')
    links.style.minHeight = '56px'
    return [
      el('div', { class: 's-head' }, el('span'), el('b', null, T.edit), el('button', { type: 'button', onclick: () => { document.activeElement && document.activeElement.blur(); setTimeout(() => { finishEdit(); sheet.mode = 'actions'; renderSheet() }) } }, T.close)),
      el('label', { class: 'field' }, T.title, title),
      el('label', { class: 'field' }, T.note, note),
      el('div', { class: 'field' }, T.priority, seg('priority', store.PRIORITIES)),
      el('div', { class: 'field' }, T.type, seg('assignee', store.ASSIGNEES)),
      el('div', { class: 'field' }, T.due, el('div', { class: 'inline' }, due, d.due ? el('button', { type: 'button', onclick: () => { save({ due: null }); renderSheet() } }, T.clearDue) : null)),
      el('label', { class: 'field' }, T.tags, tags),
      el('label', { class: 'field' }, T.links, links),
    ]
  }
  /** 编辑结束：改了哪些告诉记下它的会话 */
  function finishEdit() {
    const before = sheet && sheet.snapshot, after = current()
    if (!before || !after) return
    sheet.snapshot = null
    const f = []
    const add = (cond, key) => { if (cond) f.push(T[key] || key) }
    add(before.title !== after.title, 'title'); add(before.note !== after.note, 'note'); add(before.priority !== after.priority, 'priority')
    add(before.assignee !== after.assignee, 'type'); add(before.due !== after.due, 'due'); add(before.tags.join() !== after.tags.join(), 'tags'); add(before.links.join() !== after.links.join(), 'links')
    if (f.length) noteSession(after, 'nEdit', { f: f.map((x) => x.replace(/（.*$|\s*\(.*$/, '')).join(zh ? '、' : ', ') })
  }

  // ---------- 一段话（AI） ----------
  const OP_SCHEMA = {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'one short sentence to the user summarizing what you will do, in their language' },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'done', 'reopen', 'trash', 'comment', 'run', 'check'] },
            id: { type: 'string', description: 'existing todo id (not for add)' },
            title: { type: 'string' }, note: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'normal', 'low'] },
            assignee: { type: 'string', enum: ['agent', 'human', 'undecided'] },
            due: { type: 'string', description: 'YYYY-MM-DD' },
            tags: { type: 'array', items: { type: 'string' } },
            project: { type: 'string', description: 'one of the known project paths, or empty' },
            text: { type: 'string', description: 'comment text (comment op)' },
          },
          required: ['op'],
        },
      },
    },
    required: ['reply', 'ops'],
  }
  async function pickModel() {
    const cached = kv.getItem('ui.aiModel')
    const models = await wt.ai.models()
    if (cached && models.some((m) => m.id === cached)) return cached
    const m = models.find((x) => x.provider === 'claude' && x.tier === 'fast' && x.structured) || models.find((x) => x.tier === 'fast' && x.structured) || models.find((x) => x.structured) || models[0]
    if (!m) throw new Error(T.aiNoModel)
    setKv('ui.aiModel', m.id)
    return m.id
  }
  async function analyze(text) {
    openSheet(null, 'ai')
    sheet.ai = { text, busy: true }
    renderSheet()
    try {
      const model = await pickModel()
      const items = store.list({ status: 'all' }).slice(0, 150).map((d) => ({ id: d.id, title: d.title, status: d.status, assignee: d.assignee, priority: d.priority, due: d.due, project: d.project ? store.base(d.project) : '', tags: d.tags }))
      const projects = [...new Set(store.list({ status: 'all' }).map((d) => d.project).filter(Boolean))]
      const sys = [
        'You turn what the user says into operations on their todo list. Today is ' + store.today() + '.',
        'Ops: add (new item: title required; note, priority, assignee agent|human|undecided, due YYYY-MM-DD, tags, project), update (id + fields to change), done, reopen, trash (delete), comment (id + text), run (send the item to its agent session to do it now), check (send it to its agent session to check its status).',
        'Match existing items by meaning; use their ids exactly. Only include what the user asked for. Resolve relative dates against today. Write titles and text in the user\'s language. If nothing applies, return an empty ops list and say why in reply.',
        'Known projects (use the full path for project): ' + JSON.stringify(projects),
        'Current todos: ' + JSON.stringify(items),
      ].join('\n')
      const r = await platform.ai.complete({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], responseFormat: OP_SCHEMA, reasoning: 'low' })
      const out = r.structured || (() => { try { return JSON.parse(r.text) } catch (e) { return null } })() || { reply: r.text, ops: [] }
      if (!sheet || sheet.mode !== 'ai') return
      sheet.ai = { text, busy: false, reply: out.reply || '', ops: (out.ops || []).map((o) => Object.assign({ on: true }, o)) }
    } catch (e) {
      if (!sheet || sheet.mode !== 'ai') return
      sheet.ai = { text, busy: false, error: e.code === 'EWTPERM' ? (zh ? '要允许「AI」权限' : 'Allow the AI permission') : e.message, ops: [] }
    }
    renderSheet()
  }
  function opLabel(o) {
    const d = o.id ? attempt(() => store.get(o.id)) : null
    const k = { add: T.opAdd, update: T.opUpdate, done: T.opDone, reopen: T.opReopen, trash: T.opTrash, comment: T.opComment, run: T.opRun, check: T.opCheck }[o.op] || o.op
    const main = o.op === 'add' ? o.title : d ? d.title : (o.id || '') + T.opMissing
    const extra = []
    if (o.op === 'add' || o.op === 'update') {
      if (o.op === 'update' && o.title) extra.push(`${T.title}：${o.title}`)
      if (o.assignee) extra.push(T[o.assignee]); if (o.priority) extra.push(`${T.priority} ${T[o.priority]}`); if (o.due) extra.push(fmt(T.dueIn, { d: o.due }))
      if (o.tags && o.tags.length) extra.push(o.tags.map((t) => '#' + t).join(' ')); if (o.project) extra.push(store.base(o.project)); if (o.note) extra.push(o.note)
    }
    if (o.op === 'comment' && o.text) extra.push(o.text)
    return [el('span', { class: 'opk' }, k), main, extra.length ? el('small', null, extra.join(' · ')) : null]
  }
  function aiSheet() {
    const a = sheet.ai || {}
    const ok = (a.ops || []).filter((o) => o.on && (o.op === 'add' ? o.title : attempt(() => store.get(o.id))))
    return [
      el('div', { class: 's-head' }, el('button', { type: 'button', onclick: closeSheet }, T.cancel), el('b', null, T.ai), el('span')),
      el('div', { class: 's-meta' }, '“' + a.text + '”'),
      a.busy ? el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' ', T.aiWorking) : null,
      a.error ? el('div', { class: 'aireply' }, a.error) : a.reply ? el('div', { class: 'aireply' }, a.reply) : null,
      !a.busy && !a.error && !(a.ops || []).length ? el('div', { class: 'hint' }, T.aiNone) : null,
      el('div', { class: 'ops' }, (a.ops || []).map((o) => {
        const cb = el('input', { type: 'checkbox', onchange: (e) => { o.on = e.target.checked; renderSheet() } })
        cb.checked = !!o.on
        return el('label', null, cb, el('div', null, opLabel(o)))
      })),
      a.busy ? null : el('div', { class: 'foot' }, el('button', { type: 'button', onclick: closeSheet }, T.cancel), el('button', { type: 'button', class: 'primary', disabled: ok.length ? null : true, onclick: () => applyOps(ok) }, fmt(T.aiApply, { n: ok.length }))),
    ]
  }
  async function applyOps(ops) {
    let n = 0
    const projects = [...new Set(store.list({ status: 'all' }).map((d) => d.project).filter(Boolean))]
    const projectOf = (p) => (!p ? '' : projects.find((x) => x === p) || projects.find((x) => store.base(x) === store.base(p)) || '')
    for (const o of ops) {
      const d = o.id ? attempt(() => store.get(o.id)) : null
      try {
        if (o.op === 'add') { store.add({ title: o.title, note: o.note, priority: o.priority, assignee: o.assignee, due: o.due, tags: o.tags, project: projectOf(o.project) || project }, PHONE); n++ }
        else if (!d) continue
        else if (o.op === 'update') {
          const patch = {}
          for (const k of ['title', 'note', 'priority', 'assignee', 'due', 'tags']) if (o[k] !== undefined && o[k] !== '') patch[k] = o[k]
          if (o.project) patch.project = projectOf(o.project)
          store.update(d.id, patch, PHONE); noteSession(d, 'nEdit', { f: Object.keys(patch).join(', ') }); n++
        }
        else if (o.op === 'done' || o.op === 'reopen') { store.setDone(d.id, o.op === 'done', '', PHONE); noteSession(d, o.op === 'done' ? 'nDone' : 'nReopen'); n++ }
        else if (o.op === 'trash') { store.trash(d.id, PHONE); noteSession(d, 'nTrash'); n++ }
        else if (o.op === 'comment' && o.text) { store.comment(d.id, o.text, PHONE, false); noteSessionText(d, fmt(T.nComment, { t: d.title, id: d.id, c: o.text })); n++ }
        else if (o.op === 'run' || o.op === 'check') {
          const list = await loadSessions(true)
          const s = originOf(d, list)
          if (!s) { toast(`${d.title}：${T.noOrigin}`); continue }
          await dispatch(d, o.op, { s, origin: true }, buildPrompt(d, o.op, !!kv.getItem('ui.subagent'))); n++
        }
      } catch (e) { toast(e.message) }
    }
    closeSheet()
    render()
    toast(fmt(T.aiDone, { n }))
  }

  // ---------- 新建 / 一段话 ----------
  const input = $('addInput'), aiInput = $('aiInput')
  const refreshAdd = () => { $('addBtn').disabled = !(aiMode ? aiInput.value : input.value).trim() }
  input.addEventListener('input', refreshAdd)
  aiInput.addEventListener('input', refreshAdd)
  $('aiBtn').onclick = () => {
    aiMode = !aiMode
    $('aiBtn').setAttribute('aria-pressed', String(aiMode))
    $('addForm').classList.toggle('ai', aiMode)
    input.hidden = aiMode
    aiInput.hidden = !aiMode
    $('addBtn').textContent = aiMode ? T.analyze : T.add
    $('addBtn').classList.toggle('go', aiMode)
    ;(aiMode ? aiInput : input).focus()
    refreshAdd()
  }
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault()
    if (aiMode) {
      const text = aiInput.value.trim()
      if (!text) return
      aiInput.value = ''
      refreshAdd()
      aiInput.blur()
      analyze(text)
      return
    }
    const title = input.value.trim()
    if (!title) return
    if (attempt(() => store.add({ title, project }, PHONE))) {
      input.value = ''
      refreshAdd()
      if (status !== 'active' && status !== 'all') setStatus('active')
      else render()
    }
  })

  // 主输入框里「记成待办」带进来的文字：直接记下
  utools.onPluginEnter(({ code, payload }) => {
    if (code === 'add' && typeof payload === 'string' && payload.trim()) {
      if (attempt(() => store.add({ title: payload.trim().slice(0, 200), project }, PHONE))) { toast(T.added); render() }
    } else render()
  })
  // agent 经插件工具写的、别的设备改的：服务端推过来后重画
  utools.onDbPull(() => render())
  setInterval(() => { if (document.visibilityState === 'visible' && !sheet && !dragging) render() }, 60000)
  attempt(() => store.purgeOld())
  render()
  // 有 agent 记的老待办没有会话 id：先找一次会话，补上
  if (store.list({ status: 'all' }).some((d) => d.source && d.source.by === 'agent' && !d.source.session)) loadSessions()
  window.__todoApp = { render, analyze, applyOps } // 测试用
})()
