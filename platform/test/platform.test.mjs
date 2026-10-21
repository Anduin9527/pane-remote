// 平台 core 的单元测试：node --test platform/test/
// 权限状态机、RPC 分发（服务端 / 前端 / Mac 待定）、审计、目录扫描、插件静态文件（CSP、注入、越界路径）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createPermissions } from '../permissions.mjs'
import { createPlatform } from '../index.mjs'
import { support, supportTable, createLimiter } from '../rpc.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-platform-'))
const hello = { id: 'hello', name: 'Hello', permissions: { notification: { reason: '演示' } } }

/** 记下每次问询，按脚本回答 */
function asker(...answers) {
  const asked = []
  return { asked, ctx: { prompt: async (req) => { asked.push(req); return answers.shift() ?? 'dismiss' } } }
}

test('权限：默认询问，仅本次只在这次打开里有效', async () => {
  const p = createPermissions({ file: null })
  const a = asker('once')
  await p.permit(a.ctx, hello, 'notification')
  assert.equal(a.asked.length, 1)
  assert.equal(a.asked[0].reason, '演示')
  await p.permit(a.ctx, hello, 'notification') // 本次已允许：不再问
  assert.equal(a.asked.length, 1)
  p.endSession(hello)
  const b = asker('dismiss')
  await assert.rejects(p.permit(b.ctx, hello, 'notification'), (e) => e.code === 'EWTPERM')
  assert.equal(b.asked.length, 1)
})

test('权限：始终允许 / 禁止会存盘，重启后还在', async () => {
  const dir = tmp()
  const file = path.join(dir, 'permissions.json')
  const p = createPermissions({ file })
  await p.permit(asker('always').ctx, hello, 'notification')
  await assert.rejects(p.permit(asker('block').ctx, hello, 'clipboard.write'), (e) => e.code === 'EWTPERM' && e.permission === 'clipboard.write')
  const p2 = createPermissions({ file })
  const a = asker()
  await p2.permit(a.ctx, hello, 'notification')
  await assert.rejects(p2.permit(a.ctx, hello, 'clipboard.write'))
  assert.equal(a.asked.length, 0, '记住的结论不再问')
  assert.deepEqual(p2.list(hello).find((x) => x.id === 'clipboard.write')?.decision, 'deny')
  p2.set(hello, 'clipboard.write', 'ask')
  assert.equal(p2.check(hello, 'clipboard.write'), 'ask')
})

test('权限：连续关掉 3 次转为禁止，跨插件的多次打开也累计', async () => {
  const p = createPermissions({ file: null })
  for (let i = 0; i < 2; i++) {
    await assert.rejects(p.permit(asker('dismiss').ctx, hello, 'notification'))
    p.endSession(hello)
    assert.equal(p.check(hello, 'notification'), 'ask')
  }
  await assert.rejects(p.permit(asker('dismiss').ctx, hello, 'notification'))
  p.endSession(hello)
  assert.equal(p.check(hello, 'notification'), 'deny')
  const a = asker()
  await assert.rejects(p.permit(a.ctx, hello, 'notification'))
  assert.equal(a.asked.length, 0)
})

test('权限：没有能问的人按「以后再说」；默认授予的不问', async () => {
  const p = createPermissions({ file: null })
  await assert.rejects(p.permit({}, hello, 'notification'))
  const a = asker()
  await p.permit(a.ctx, hello, 'storage')
  await p.permit(a.ctx, hello, 'platform.incident')
  assert.equal(a.asked.length, 0)
})

test('权限：共享存储按组记（始终允许 demo 组不等于允许别的组）', async () => {
  const p = createPermissions({ file: null })
  await p.permit(asker('always').ctx, hello, 'platform.storage', 'demo')
  const a = asker('dismiss')
  await p.permit(a.ctx, hello, 'platform.storage', 'demo')
  await assert.rejects(p.permit(a.ctx, hello, 'platform.storage', 'other'))
  assert.equal(a.asked.length, 1)
})

test('support 表：旧名能查，Mac 能力标成待 pane-host', () => {
  assert.equal(support('showNotification').name, 'system.notify')
  assert.equal(support('dbStorage.setItem').impl, 'local')
  assert.deepEqual([support('shellOpenPath').impl, support('shellOpenPath').support], ['mac', 'none'])
  assert.equal(support('screenCapture').impl, 'mac')
  assert.equal(support('copyText').impl, 'web')
  assert.equal(support('platform.incident.report').support, 'native')
  assert.equal(support('no.such.api'), null)
  const rows = supportTable()
  assert.ok(rows.length > 100)
  assert.ok(rows.every((r) => r.name && r.support && r.impl))
})

test('限频：同一个插件 20 秒一条，全部每小时 20 条', () => {
  const lim = createLimiter()
  assert.equal(lim('a', 0), true)
  assert.equal(lim('a', 10000), false)
  assert.equal(lim('a', 20001), true)
  let ok = 0
  for (let i = 0; i < 40; i++) if (lim(`p${i}`, 30000 + i)) ok++
  assert.equal(ok, 18) // 前面已经用掉 2 条
})

function makePlatform(extra = {}) {
  const dataDir = tmp()
  const pushed = [], incidents = []
  const pf = createPlatform({
    dataDir,
    pluginsDir: path.join(REPO, 'plugins'),
    WebSocketServer,
    notify: async (p) => { pushed.push(p); return { sent: 1 } },
    recordIncident: (r) => { incidents.push(r); return { id: 'abcdefabcdef' } },
    ...extra,
  })
  return { pf, pushed, incidents, dataDir }
}
const ctx = (over = {}) => ({ client: 'c1', test: false, visible: () => true, prompt: async () => 'once', ...over })

test('目录：认 plugin.json + whatevertools.json，功能指令带拼音', () => {
  const { pf } = makePlatform()
  const h = pf._catalog.list().find((p) => p.id === 'hello')
  assert.ok(h)
  assert.equal(h.name, 'Hello')
  assert.equal(h.main, 'plugins/hello/index.html')
  const cmd = h.features[0].cmds[0]
  assert.deepEqual([cmd.label, cmd.py, cmd.pyi], ['你好', 'nihao', 'nh'])
  assert.equal(h.permissions.notification.reason, '演示：点「通知」时提醒你')
})

test('RPC：不认识的、Mac 端的方法回 EWTUNSUPPORTED 并记审计', async () => {
  const { pf } = makePlatform()
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'shell.openPath', {}), (e) => e.code === 'EWTUNSUPPORTED' && /pane-host/.test(e.message))
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'nope.nope', {}), (e) => e.code === 'EWTUNSUPPORTED')
  await assert.rejects(pf._rpc.call(ctx(), 'nobody', 'system.notify', {}), (e) => e.code === 'ENOPLUGIN')
  const rows = pf._audit.list('hello')
  assert.deepEqual(rows.map((r) => [r.method, r.result, r.impl]), [['nope.nope', 'unsupported', 'none'], ['shell.openPath', 'unsupported', 'mac']])
})

test('RPC：前端实现的能力先过权限再回 $delegate；拒绝时不交给前端', async () => {
  const { pf } = makePlatform()
  assert.deepEqual(await pf._rpc.call(ctx(), 'hello', 'clipboard.writeText', { text: 'x' }), { $delegate: 'clipboard.writeText' })
  await assert.rejects(pf._rpc.call(ctx({ prompt: async () => 'block' }), 'hello', 'shell.openExternal', { url: 'https://example.com' }), (e) => e.code === 'EWTPERM')
  const rows = pf._audit.list('hello')
  assert.deepEqual(rows.map((r) => r.result), ['denied', 'delegated'])
})

test('RPC：通知——手机在看是页内提示，不在看推送，测试来源不推', async () => {
  const { pf, pushed } = makePlatform()
  const always = ctx({ prompt: async () => 'always' })
  assert.deepEqual(await pf._rpc.call(always, 'hello', 'system.notify', { body: 'hi' }), { $delegate: 'system.notify' })
  assert.deepEqual(await pf._rpc.call(ctx({ visible: () => false }), 'hello', 'system.notify', { body: 'hi' }), { pushed: true })
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].title, 'Hello')
  assert.deepEqual(await pf._rpc.call(ctx({ visible: () => false, test: true }), 'hello', 'system.notify', { body: 'hi' }), { pushed: false, test: true })
  assert.equal(pushed.length, 1)
})

test('RPC：数据库副本推上来按 rev 裁决并落盘', async () => {
  const { pf, dataDir } = makePlatform()
  const r = await pf._rpc.call(ctx(), 'hello', 'db.push', { docs: [{ _id: 'a', _rev: '1-x', v: 1 }, { _id: '\u0000storage/count', _rev: '1-y', value: 3 }] })
  assert.equal(r.applied, 2)
  const r2 = await pf._rpc.call(ctx(), 'hello', 'db.push', { docs: [{ _id: 'a', _rev: '1-a', v: 0 }] }) // 同版本号、字符串小的输
  assert.equal(r2.applied, 0)
  pf.flush()
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins/db/hello/db.json'), 'utf8'))
  assert.equal(saved.docs.a.v, 1)
  assert.equal(saved.docs['\u0000storage/count'].value, 3)
})

test('RPC：问题报告——插件报的和自动上报的都标 plugin:<id>，测试来源带 test', async () => {
  const { pf, incidents } = makePlatform()
  await pf._rpc.call(ctx({ test: true }), 'hello', 'platform.incident.report', { title: '坏了', detail: 'd' })
  await pf._rpc.call(ctx(), 'hello', 'platform.incident.auto', { kind: 'error', msg: 'TypeError: x is undefined\n at y' })
  assert.deepEqual(incidents.map((i) => [i.source, i.component, i.kind, !!i.test]), [['plugin', 'plugin:hello', 'report', true], ['plugin', 'plugin:hello', 'error', false]])
  assert.equal(incidents[1].msg, 'TypeError: x is undefined')
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'platform.incident.report', {}), (e) => e.code === 'EBADARG')
})

test('RPC：共享存储只认声明过的组', async () => {
  const { pf } = makePlatform()
  const c = ctx({ prompt: async () => 'always' })
  assert.equal(await pf._rpc.call(c, 'hello', 'platform.storage.set', { group: 'demo', key: 'k', value: { a: 1 } }), true)
  assert.deepEqual(await pf._rpc.call(c, 'hello', 'platform.storage.get', { group: 'demo', key: 'k' }), { a: 1 })
  assert.deepEqual(await pf._rpc.call(c, 'hello', 'platform.storage.keys', { group: 'demo' }), ['k'])
  await assert.rejects(pf._rpc.call(c, 'hello', 'platform.storage.get', { group: 'secret', key: 'k' }), /没有在 whatevertools.json/)
})

test('RPC：在手机上提问，回答后插件拿到结果；手机不在看时推送', async () => {
  const { pf, pushed } = makePlatform()
  const p = pf._rpc.call(ctx({ prompt: async () => 'always' }), 'hello', 'platform.agent.ask', { question: '好吗？', options: ['好', '不好'] })
  await new Promise((r) => setTimeout(r, 20))
  const [a] = pf._asks.list()
  assert.equal(a.question, '好吗？')
  assert.equal(pushed.length, 1, '没有连着的前端：推送')
  assert.throws(() => pf.answerAsk(a.id, '随便'), /bad answer/)
  assert.equal(pf.answerAsk(a.id, '', '自己写的'), true)
  assert.deepEqual(await p, { answered: true, answer: '', text: '自己写的' })
  assert.equal(pf._asks.list().length, 0)
  assert.equal(pf.answerAsk('0'.repeat(24), '好'), false)
})

test('HTTP：插件文件带 CSP、注入运行时和启动数据，越界路径 404', async () => {
  const { pf } = makePlatform()
  await pf._rpc.call(ctx(), 'hello', 'db.push', { docs: [{ _id: '\u0000storage/count', _rev: '1-y', value: 7 }] })
  const server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://x'); if (!(await pf.handle(req, res, url, async () => ({})))) { res.writeHead(418); res.end() } })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await fetch(`${base}/plugins/hello/`)
    assert.equal(r.status, 200)
    const policy = r.headers.get('content-security-policy')
    assert.match(policy, /^sandbox allow-scripts allow-forms;/)
    assert.match(policy, /frame-ancestors 'self'/)
    const html = await r.text()
    assert.match(html, /<head><script>window.__paneRemoteBoot=/)
    const boot = JSON.parse(/__paneRemoteBoot=(.*?)<\/script>/.exec(html)[1])
    assert.equal(boot.plugin.id, 'hello')
    assert.equal(boot.platform.name, 'pane-remote')
    assert.equal(boot.legacy.showNotification, 'system.notify')
    assert.equal(boot.db.docs.find((d) => d._id === '\u0000storage/count').value, 7)
    assert.ok(!html.includes('</script><script>alert'), 'JSON 里的 < 已转义')
    assert.equal((await fetch(`${base}/plugins/hello/logo.svg`)).headers.get('content-type'), 'image/svg+xml')
    // fetch 和 new URL 都会先把明文的 .. 规整掉（%2e%2e 也算；/plugins/hello/../../x 变成 /x，根本到不了这里）：编码过的越界路径用原始请求发
    const raw = (p) => new Promise((resolve) => http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => { r.resume(); resolve(r.statusCode) }))
    for (const bad of ['/plugins/hello/..%2f..%2fserver.mjs', '/plugins/hello/.hidden', '/plugins/nope/index.html']) assert.equal(await raw(bad), 404, bad)
    // CORS：只给同一个插件页面发的 Origin: null 请求
    const host = `127.0.0.1:${server.address().port}`
    const cors = async (ref) => (await fetch(`${base}/plugins/hello/logo.svg`, { headers: { origin: 'null', referer: ref } })).headers.get('access-control-allow-origin')
    assert.equal(await cors(`http://${host}/plugins/hello/index.html`), 'null')
    assert.equal(await cors(`http://${host}/plugins/other/index.html`), null)
    assert.equal(await cors('https://evil.example/plugins/hello/'), null)
    assert.equal((await fetch(`${base}/plugins/_runtime.js`)).status, 200)
    const list = await (await fetch(`${base}/api/plugins`)).json()
    assert.ok(list.plugins.some((p) => p.id === 'hello'))
    assert.equal((await fetch(`${base}/elsewhere`)).status, 418)
  } finally { server.close() }
})
