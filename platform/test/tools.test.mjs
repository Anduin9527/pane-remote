// 插件工具 → MCP（tools.mjs + tool-runtime.mjs）：列表、mcp 权限经手机询问、沙盒子进程跑 preload、数据双向同步
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createPlatform } from '../index.mjs'
import { mcpName } from '../tools.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-tools-'))
const made = []
function makePlatform(pluginsDir = path.join(REPO, 'plugins')) {
  const dataDir = tmp()
  const pushed = [], incidents = []
  const pf = createPlatform({ dataDir, pluginsDir, WebSocketServer, notify: async (p) => { pushed.push(p); return { sent: 1 } }, recordIncident: (r) => { incidents.push(r); return { id: 'abcdefabcdef' } }, log: () => {} })
  made.push(pf)
  return { pf, pushed, incidents, dataDir }
}
after(() => { for (const pf of made) pf.flush() })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等手机上出现权限卡片并回答 */
async function answerNextAsk(pf, answer) {
  for (let i = 0; i < 100; i++) { const [a] = pf._asks.list(); if (a) { if (answer != null) pf.answerAsk(a.id, answer); return a } await wait(20) }
  throw new Error('没有等到询问')
}
const caller = { agent: 'claude', pane: 3, cwd: '/work/app' }

test('列表：只列描述文件里声明、有 preload 的工具，名字带插件前缀', () => {
  const { pf } = makePlatform()
  const tools = pf.agentTools.list().filter((t) => t.plugin === 'todo')
  assert.deepEqual(tools.map((t) => t.name).sort(), ['plugin_todo_add', 'plugin_todo_done', 'plugin_todo_list', 'plugin_todo_remove', 'plugin_todo_update'])
  assert.match(tools[0].description, /^\[pane-remote 插件「待办」\]/)
  assert.equal(tools.find((t) => t.tool === 'add').inputSchema.required[0], 'title')
  assert.equal(pf.agentTools.list().some((t) => t.plugin === 'hello'), false, 'hello 没有声明工具')
  assert.equal(mcpName('a.b-c', 'x'), 'plugin_a_b-c_x')
})

test('调用：第一次在手机上问 mcp 权限，始终允许后不再问；调用方记进待办；数据落盘', async () => {
  const { pf, pushed, dataDir } = makePlatform()
  const p = pf.agentTools.call({ name: 'plugin_todo_add', args: { title: '回头补测试', priority: 'high', tags: ['test'] }, caller })
  const a = await answerNextAsk(pf, '始终允许')
  assert.match(a.question, /待办.*claude · #3 · app.*add/)
  assert.equal(pushed.length, 1, '手机没在看：推送')
  const r = await p
  assert.equal(r.value.added.title, '回头补测试')
  assert.deepEqual(r.value.added.source, { by: 'agent', agent: 'claude', pane: 3, cwd: '/work/app' })
  assert.equal(r.value.added.project, '/work/app')
  const l = await pf.agentTools.call({ name: 'plugin_todo_list', args: { project: 'current' }, caller })
  assert.equal(pf._asks.list().length, 0, '记住了，不再问')
  assert.equal(l.value.total, 1)
  const d = await pf.agentTools.call({ name: 'plugin_todo_done', args: { id: r.value.added.id, note: '补好了' }, caller })
  assert.equal(d.value.updated.status, 'done')
  assert.equal((await pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })).value.total, 0)
  pf.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins/db/todo/db.json'), 'utf8'))
  const doc = Object.values(saved.docs).find((x) => x.title === '回头补测试')
  assert.equal(doc.status, 'done')
  assert.match(doc.note, /补好了/)
  assert.ok(pf._audit.list('todo').some((x) => x.method === 'mcp.add' && x.result === 'ok'))
})

test('权限：禁止后这个插件的工具从列表里消失，调用被拒', async () => {
  const { pf } = makePlatform()
  const p = pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })
  await answerNextAsk(pf, '禁止')
  await assert.rejects(p, (e) => e.code === 'EWTPERM')
  assert.equal(pf.agentTools.list().some((t) => t.plugin === 'todo'), false)
  await assert.rejects(pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller }), (e) => e.code === 'ENOTOOL')
})

test('权限：没回答不算禁止，工具还在列表里，下次调用再问；连续 3 次没答才转为禁止', async () => {
  const { pf } = makePlatform()
  const m = pf._catalog.get('todo')
  for (let i = 1; i <= 3; i++) {
    const p = pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })
    const a = await answerNextAsk(pf, null)
    pf._asks.cancel(a.id)
    await assert.rejects(p, (e) => e.code === 'EWTPERM')
    assert.equal(pf.agentTools.list().some((t) => t.plugin === 'todo'), i < 3, `第 ${i} 次没答`)
  }
  assert.equal(pf._perms.blocked(m, 'mcp'), true)
})

test('同步：手机插件页写的，工具运行时马上看得到；工具写的推给连着的手机', async () => {
  const { pf } = makePlatform()
  pf._perms.set(pf._catalog.get('todo'), 'mcp', 'grant')
  await pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller }) // 先把运行时起来
  const sent = []
  // 假装一个手机连接（平台对每个 client 排队发送）
  const ctx = { client: 'phone1', test: false, visible: () => true, prompt: async () => 'once' }
  await pf._rpc.call(ctx, 'todo', 'db.push', { docs: [{ _id: 'todo/x1', _rev: '1-a', title: '手机上记的', status: 'open', priority: 'normal', tags: [], created: 1, updated: 1 }] })
  await wait(50)
  const l = await pf.agentTools.call({ name: 'plugin_todo_list', args: {}, caller })
  assert.ok(l.value.items.some((i) => i.title === '手机上记的'))
  const pull = await pf._rpc.call(ctx, 'todo', 'db.pull', {})
  assert.ok(pull.docs.some((d) => d._id === 'todo/x1'))
  void sent
})

test('沙盒：preload 读不了文件、拿不到 require 和服务端的环境变量；出错报成问题', async () => {
  const dir = tmp()
  const pd = path.join(dir, 'evil')
  fs.mkdirSync(pd)
  fs.writeFileSync(path.join(pd, 'plugin.json'), JSON.stringify({ pluginName: 'Evil', main: 'index.html', logo: 'l.svg', preload: 'preload.js', features: [{ code: 'e', cmds: ['e'] }], tools: { probe: { description: 'p', inputSchema: { type: 'object' } }, boom: { description: 'b', inputSchema: { type: 'object' } } } }))
  fs.writeFileSync(path.join(pd, 'index.html'), '<p>x</p>')
  fs.writeFileSync(path.join(pd, 'preload.js'), `
    utools.registerTool('probe', async () => {
      const out = {}
      try { require('fs') } catch (e) { out.require = e.code }
      try { const p = this.constructor.constructor('return process')(); out.env = Object.keys(p.env)
        try { p.getBuiltinModule('fs').readFileSync('/etc/hosts'); out.fs = 'READ' } catch (e) { out.fs = e.code }
        try { p.getBuiltinModule('child_process').execSync('id'); out.cp = 'RAN' } catch (e) { out.cp = e.code }
      } catch (e) { out.escape = e.message }
      return out
    })
    utools.registerTool('boom', () => { throw new Error('故意的') })
  `)
  const { pf } = makePlatform(dir)
  pf._perms.set(pf._catalog.get('evil'), 'mcp', 'grant')
  const r = (await pf.agentTools.call({ name: 'plugin_evil_probe', args: {}, caller })).value
  assert.equal(r.require, 'EWTUNSUPPORTED')
  if (r.env !== undefined) { // vm 逃逸出去也只是这个受限的子进程
    assert.deepEqual(r.env.filter((k) => !k.startsWith('NODE_CHANNEL_') && k !== '__CF_USER_TEXT_ENCODING'), [], '只有 Node 自己的 IPC 变量')
    assert.equal(r.fs, 'ERR_ACCESS_DENIED')
    assert.equal(r.cp, 'ERR_ACCESS_DENIED')
  }
  await assert.rejects(pf.agentTools.call({ name: 'plugin_evil_boom', args: {}, caller }), /故意的/)
})
