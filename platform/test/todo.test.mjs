// 待办插件的数据层（plugins/todo/preload.js）：在 vm 里跑，utools.db 用一个按 rev 检查冲突的内存实现
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const SRC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugins/todo/preload.js'), 'utf8')
function load() {
  const docs = new Map()
  let n = 0
  const db = {
    put(d) {
      const cur = docs.get(d._id)
      if (cur && cur._rev !== d._rev) return { id: d._id, error: true, name: 'conflict' }
      const doc = JSON.parse(JSON.stringify(d))
      doc._rev = `${++n}-x`
      docs.set(d._id, doc)
      return { id: d._id, ok: true, rev: doc._rev }
    },
    get: (id) => (docs.has(id) ? JSON.parse(JSON.stringify(docs.get(id))) : null),
    remove: (d) => (docs.delete(d._id) ? { ok: true } : { error: true }),
    allDocs: (p) => [...docs.values()].filter((d) => d._id.startsWith(p)).map((d) => JSON.parse(JSON.stringify(d))),
  }
  const tools = {}
  const ctx = { utools: { db, registerTool: (n, f) => { tools[n] = f } }, console }
  ctx.window = ctx
  vm.runInNewContext(SRC, ctx)
  return { store: ctx.todoStore, tools, docs }
}
const agentCtx = (session = 's-1111aaaa', pane = 3) => ({ caller: { agent: 'claude', pane, cwd: '/w/app', session } })

test('新建：处理类型、截止日期、动态；过期判断', () => {
  const { store } = load()
  const a = store.add({ title: '回邮件', assignee: 'human', due: '2000-01-01', priority: 'high' }, { by: 'phone' })
  assert.equal(a.assignee, 'human')
  assert.equal(a.overdue, true)
  assert.equal(a.log[0].kind, 'created')
  assert.throws(() => store.add({ title: 'x', due: '明天' }), /YYYY-MM-DD/)
  assert.throws(() => store.add({ title: 'x', assignee: 'robot' }), /assignee/)
  assert.equal(store.list({ overdue: true }).length, 1)
})

test('agent：认领 → 处理中（记下会话）；别的会话认领被拒，force 可以接手', () => {
  const { store, tools } = load()
  const { added } = tools.add({ title: '修 bug', assignee: 'agent' }, agentCtx())
  assert.equal(added.source.session, 's-1111aaaa')
  const r = tools.start({ id: added.id }, agentCtx())
  assert.equal(r.item.status, 'in_progress')
  assert.equal(r.item.claim.session, 's-1111aaaa')
  const other = tools.start({ id: added.id }, agentCtx('s-2222bbbb', 4))
  assert.equal(other.started, false)
  assert.match(other.reason, /claude #3/)
  assert.equal(tools.start({ id: added.id, force: true }, agentCtx('s-2222bbbb', 4)).item.claim.pane, 4)
  assert.equal(store.list({ status: 'in_progress' }).length, 1)
})

test('提问 → 等你（blocker）；手机回复 → 回到处理中；动态里都有', () => {
  const { store, tools } = load()
  const { added } = tools.add({ title: '上线' }, agentCtx())
  tools.start({ id: added.id }, agentCtx())
  tools.comment({ id: added.id, text: '用哪个域名？', needs_reply: true }, agentCtx())
  let d = store.get(added.id)
  assert.equal(d.status, 'blocked')
  assert.equal(d.blocker, '用哪个域名？')
  store.reply(added.id, '用 b 域名', { by: 'phone' })
  d = store.get(added.id)
  assert.equal(d.status, 'in_progress')
  assert.equal(d.blocker, null)
  assert.deepEqual(d.log.map((e) => e.kind), ['created', 'status', 'question', 'status', 'reply', 'status'])
  assert.equal(tools.get({ id: added.id }).item.log.length, 6)
  assert.throws(() => store.update(added.id, { status: 'blocked' }, { by: 'phone' }) && store.update(added.id, { status: 'open' }) && store.update(added.id, { status: 'blocked', blocker: '' }), /blocker/)
})

test('手机发去执行：记 run、处理中、认领人是收到的会话；检查不改状态', () => {
  const { store } = load()
  const a = store.add({ title: 't' }, { by: 'phone' })
  store.addRun(a.id, { kind: 'check', at: 1, pane: 2, agent: 'claude', session: 's-x' })
  assert.equal(store.get(a.id).status, 'open')
  store.addRun(a.id, { kind: 'run', at: 2, pane: 2, agent: 'claude', session: 's-x' })
  const d = store.get(a.id)
  assert.equal(d.status, 'in_progress')
  assert.equal(d.claim.session, 's-x')
  assert.equal(d.runs.length, 2)
})

test('回收站：删除可恢复，只能彻底删除回收站里的，清空；agent 的 remove 也是进回收站', () => {
  const { store, tools } = load()
  const a = store.add({ title: 'a' }, { by: 'phone' })
  const b = store.add({ title: 'b' }, { by: 'phone' })
  assert.throws(() => store.purge(a.id), /回收站/)
  store.trash(a.id, { by: 'phone' })
  assert.equal(tools.remove({ id: b.id }, agentCtx()).trashed.trashed_at > 0, true)
  assert.equal(store.list({ status: 'all' }).length, 0)
  assert.equal(store.list({ status: 'trash' }).length, 2)
  store.restore(a.id, { by: 'phone' })
  assert.equal(store.list().length, 1)
  assert.equal(store.emptyTrash(), 1)
  assert.equal(store.list({ status: 'trash' }).length, 0)
})

test('排序：智能（等你 > 过期 > 优先级）、截止日期、手动（拖动）', () => {
  const { store } = load()
  const low = store.add({ title: 'low', priority: 'low' }, { by: 'phone' })
  const high = store.add({ title: 'high', priority: 'high' }, { by: 'phone' })
  const late = store.add({ title: 'late', due: '2000-01-01' }, { by: 'phone' })
  const wait = store.add({ title: 'wait' }, { by: 'phone' })
  store.update(wait.id, { status: 'blocked', blocker: '?' }, { by: 'phone' })
  assert.deepEqual(store.list().map((d) => d.title), ['wait', 'late', 'high', 'low'])
  assert.deepEqual(store.list({ sort: 'due' }).map((d) => d.title)[0], 'late')
  store.seedOrder([low.id, high.id, late.id, wait.id])
  store.move(wait.id, low.id, high.id) // 拖到 low 和 high 之间
  assert.deepEqual(store.list({ sort: 'manual' }).map((d) => d.title), ['low', 'wait', 'high', 'late'])
  store.move(late.id, null, low.id) // 拖到最前
  assert.deepEqual(store.list({ sort: 'manual' }).map((d) => d.title), ['late', 'low', 'wait', 'high'])
})

test('agent 的 list：open = 没做完的，not_started / in_progress / blocked 精确', () => {
  const { tools } = load()
  const a = tools.add({ title: 'a' }, agentCtx()).added
  tools.add({ title: 'b' }, agentCtx())
  tools.start({ id: a.id }, agentCtx())
  assert.equal(tools.list({}, agentCtx()).total, 2)
  assert.equal(tools.list({ status: 'not_started' }, agentCtx()).total, 1)
  assert.equal(tools.list({ status: 'in_progress' }, agentCtx()).total, 1)
  assert.equal(tools.list({}, agentCtx()).items[0].log, undefined, '列表不带动态')
})
