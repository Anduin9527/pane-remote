// 平台 core 的 Mac 能力分发（假 pane-host，不连真的）：AI 流式 / 取消 / 工具回调、Mac 剪贴板和打开网址、只读文件的根目录和权限、
// pane-host 不在线；再走一遍 WS：stream 调用的 chunk / tool / tool-result / cancel。跑：node --test platform/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { createPlatform } from '../index.mjs'
import { support, normPath, cleanDir } from '../rpc.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-mac-'))

/** 假 HostClient：call 记下来按表回答；ai.complete 的流按脚本推片段（可以带工具请求），cancel 时以 CANCELLED 结束 */
function fakeHost({ connected = true } = {}) {
  const h = new EventEmitter()
  Object.assign(h, {
    connected, lastError: '', calls: [], streams: [],
    async call(method, params) {
      h.calls.push([method, params])
      if (method === 'ping') return { home: '/Users/me' }
      if (method === 'ai.models') return { models: [{ id: 'claude/haiku', label: 'Haiku', icon: 'data:', vision: true, provider: 'claude', efforts: [], tier: 'fast' }, { id: 'claude/sonnet', label: 'Sonnet', icon: 'data:', vision: true, provider: 'claude', efforts: ['low', 'high'], tier: 'balanced' }], skipped: {} }
      if (method === 'desktop.clipboard.readText') return 'mac text'
      if (method.startsWith('fs.')) return { method, params }
      return true
    },
    stream(method, params, onChunk) {
      const s = { method, params, replies: [], cancelled: false }
      h.streams.push(s)
      let finish, fail
      s.done = new Promise((res, rej) => { finish = res; fail = rej })
      s.cancel = () => { s.cancelled = true; fail(Object.assign(new Error('cancelled'), { code: -32800 })) }
      s.reply = (rid, r) => { s.replies.push({ rid, ...r }); if (s.onReply) s.onReply(rid, r) }
      const text = params.req.messages.at(-1).content
      setTimeout(() => {
        if (text === 'hang') return
        if (text === 'tool') {
          s.onReply = (rid, r) => { onChunk({ type: 'chunk', data: { role: 'assistant', content: `sum=${r.value?.sum}` } }); finish({ role: 'assistant', content: `sum=${r.value?.sum}` }) }
          return onChunk({ type: 'tool-call', rid: 7, name: 'add', args: { a: 2, b: 3 } })
        }
        if (text === 'auth') return fail(Object.assign(new Error('claude: Not logged in'), { code: 'auth' }))
        onChunk({ type: 'chunk', data: { role: 'assistant', content: 'He' } })
        onChunk({ type: 'chunk', data: { role: 'assistant', content: 'llo' } })
        finish(params.advanced ? { text: 'Hello', model: 'claude/haiku', usage: {} } : { role: 'assistant', content: 'Hello' })
      }, 5)
      return s
    },
  })
  return h
}

/** 临时插件目录：hello（默认）和 macy（描述文件选了 Mac 剪贴板 / 在 Mac 上打开） */
function pluginsDir() {
  const dir = tmp()
  for (const [id, extra] of [['hello', {}], ['macy', { mac: { clipboard: true, openExternal: true } }]]) {
    fs.mkdirSync(path.join(dir, id))
    fs.writeFileSync(path.join(dir, id, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
    fs.writeFileSync(path.join(dir, id, 'whatevertools.json'), JSON.stringify({ id, name: id, main: 'index.html', logo: 'index.html', features: [{ code: id, cmds: [id] }], paneRemote: extra }))
  }
  return dir
}

function make(host = fakeHost()) {
  const pf = createPlatform({ dataDir: tmp(), pluginsDir: pluginsDir(), WebSocketServer, notify: async () => ({}), recordIncident: () => ({ id: 'x' }), host })
  return { pf, host }
}
const ctx = (over = {}) => ({ client: 'c1', test: false, visible: () => true, prompt: async () => 'always', ...over })

test('support 表：AI 是 mac 实现、旧名 ai / allAiModels 能查；没接上的 Mac 能力还是 none', () => {
  assert.deepEqual([support('ai').name, support('ai').impl, support('ai').support], ['ai.chat', 'mac', 'emulated'])
  assert.equal(support('allAiModels').name, 'ai.models')
  assert.equal(support('platform.fs.read').impl, 'mac')
  assert.equal(support('registerTool').support, 'partial')
  assert.deepEqual([support('shellOpenPath').impl, support('shellOpenPath').support], ['mac', 'none'])
})

test('AI：models 先问 ai 权限再走 pane-host；chat 片段转给 ctx.chunk', async () => {
  const { pf, host } = make()
  const asked = []
  const models = await pf._rpc.call(ctx({ prompt: async (r) => { asked.push(r.permission); return 'always' } }), 'hello', 'ai.models', {})
  assert.deepEqual(asked, ['ai'])
  assert.deepEqual(models.map((m) => m.id), ['claude/haiku', 'claude/sonnet'])
  assert.deepEqual(models[1].efforts, ['low', 'high'])
  const chunks = []
  const msg = await pf._rpc.call(ctx({ chunk: (c) => chunks.push(c.content) }), 'hello', 'ai.chat', { model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(msg, { role: 'assistant', content: 'Hello' })
  assert.equal(chunks.join(''), 'Hello')
  assert.equal(host.streams[0].params.advanced, false)
  assert.equal(host.streams[0].params.req.model, 'claude/haiku')
  // platform.ai.complete：advanced，带 responseFormat / reasoning
  const r = await pf._rpc.call(ctx(), 'hello', 'platform.ai.complete', { model: 'claude/sonnet', reasoning: 'high', responseFormat: { type: 'object' }, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(r.text, 'Hello')
  assert.deepEqual([host.streams[1].params.advanced, host.streams[1].params.req.reasoning], [true, 'high'])
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'ai.chat', { messages: [] }), (e) => e.code === 'EBADARG')
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'ai.chat', { messages: [{ role: 'user', content: 'auth' }] }), (e) => e.code === 'EAI_AUTH')
  const rows = pf._audit.list('hello')
  assert.ok(rows.some((x) => x.method === 'ai.chat' && x.result === 'ok' && x.impl === 'mac'))
})

test('AI：取消 → pane-host 收到 cancel，调用以 aborted 结束并记审计', async () => {
  const { pf, host } = make()
  const ac = new AbortController()
  const p = pf._rpc.call(ctx({ signal: ac.signal, chunk: () => {} }), 'hello', 'ai.chat', { messages: [{ role: 'user', content: 'hang' }] })
  await new Promise((r) => setTimeout(r, 30))
  ac.abort()
  await assert.rejects(p, (e) => e.code === 'aborted')
  assert.equal(host.streams[0].cancelled, true)
  assert.equal(pf._audit.list('hello')[0].result, 'cancelled')
})

test('AI：工具调用回到插件页（ctx.callTool），结果 reply 给 pane-host；没有回调时带 tools 直接报错', async () => {
  const { pf, host } = make()
  const tools = [{ type: 'function', function: { name: 'add', parameters: {} } }]
  const msg = await pf._rpc.call(ctx({ callTool: async (name, args) => ({ sum: args.a + args.b, name }) }), 'hello', 'ai.chat', { messages: [{ role: 'user', content: 'tool' }], tools })
  assert.equal(msg.content, 'sum=5')
  assert.deepEqual(host.streams[0].replies, [{ rid: 7, ok: true, value: { sum: 5, name: 'add' } }])
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'ai.chat', { messages: [{ role: 'user', content: 'tool' }], tools }), (e) => e.code === 'EBADARG')
})

test('pane-host 不在线：Mac 能力回 EWTHOSTDOWN（先过权限），手机做的照常', async () => {
  const { pf } = make(fakeHost({ connected: false }))
  await assert.rejects(pf._rpc.call(ctx(), 'hello', 'ai.models', {}), (e) => e.code === 'EWTHOSTDOWN')
  assert.deepEqual(await pf._rpc.call(ctx(), 'hello', 'clipboard.writeText', { text: 'x' }), { $delegate: 'clipboard.writeText' })
  const { pf: pf2 } = make(null)
  await assert.rejects(pf2._rpc.call(ctx(), 'hello', 'platform.mac.clipboard.readText', {}), (e) => e.code === 'EWTHOSTDOWN')
})

test('剪贴板 / 打开网址：描述文件选了 Mac 的走 pane-host，没选的交给手机；platform.mac.* 总是 Mac', async () => {
  const { pf, host } = make()
  assert.equal(await pf._rpc.call(ctx(), 'macy', 'clipboard.writeText', { text: '你好' }), true)
  assert.equal(await pf._rpc.call(ctx(), 'macy', 'shell.openExternal', { url: 'https://example.com' }), true)
  await assert.rejects(pf._rpc.call(ctx(), 'macy', 'shell.openExternal', { url: 'javascript:alert(1)' }), (e) => e.code === 'EBADARG')
  assert.deepEqual(await pf._rpc.call(ctx(), 'hello', 'shell.openExternal', { url: 'https://example.com' }), { $delegate: 'shell.openExternal' })
  assert.equal(await pf._rpc.call(ctx(), 'hello', 'platform.mac.clipboard.readText', {}), 'mac text')
  assert.deepEqual(host.calls.filter((c) => c[0].startsWith('desktop.')), [
    ['desktop.clipboard.writeText', { text: '你好' }], ['desktop.openUrl', { url: 'https://example.com' }], ['desktop.clipboard.readText', undefined],
  ])
  // 读剪贴板要 clipboard.read：拒绝了就不碰 pane-host
  await assert.rejects(pf._rpc.call(ctx({ prompt: async () => 'block' }), 'macy', 'platform.mac.clipboard.readText', {}), (e) => e.code === 'EWTPERM')
  assert.equal(host.calls.filter((c) => c[0] === 'desktop.clipboard.readText').length, 1)
  assert.deepEqual(pf._audit.list('macy').map((r) => [r.method, r.impl, r.result]).slice(0, 2), [['platform.mac.clipboard.readText', 'mac', 'denied'], ['shell.openExternal', 'mac', 'error']])
})

test('只读文件：私有目录默认允许；绝对路径换成 ~/ 找根目录；用户加的目录按目录问 fs.read；别的路径拒绝', async () => {
  const { pf, host } = make()
  const asked = []
  const c = ctx({ prompt: async (r) => { asked.push([r.permission, r.scope]); return 'once' } })
  await pf._rpc.call(c, 'hello', 'platform.fs.read', { path: 'notes/a.txt' })
  assert.deepEqual(host.calls.at(-1), ['fs.read', { plugin: 'hello', root: 'private', path: 'notes/a.txt', encoding: 'utf8', maxBytes: undefined }])
  assert.deepEqual(asked, [], '私有目录 fs.plugin 默认允许')
  await assert.rejects(pf._rpc.call(c, 'hello', 'platform.fs.list', { path: '/Users/me/Documents' }), (e) => e.code === 'EWTPERM')
  pf._fsDirs.set('hello', ['~/Documents/notes/', '/Volumes/x'])
  assert.deepEqual(pf._fsDirs.get('hello'), ['~/Documents/notes', '/Volumes/x'])
  await pf._rpc.call(c, 'hello', 'platform.fs.list', { path: '/Users/me/Documents/notes/2026' })
  assert.deepEqual(host.calls.at(-1)[1], { plugin: 'hello', root: '~/Documents/notes', path: '~/Documents/notes/2026' })
  assert.deepEqual(asked, [['fs.read', '~/Documents/notes']])
  await assert.rejects(pf._rpc.call(c, 'hello', 'platform.fs.read', { path: '~/Documents/notes/../secret' }), (e) => e.code === 'EWTPERM')
  await pf._rpc.call(c, 'hello', 'platform.fs.stat', { root: '/Volumes/x', path: 'a' })
  await assert.rejects(pf._rpc.call(c, 'hello', 'platform.fs.stat', { root: '/etc', path: 'passwd' }), (e) => e.code === 'EWTPERM')
  const roots = await pf._rpc.call(c, 'hello', 'platform.fs.roots', {})
  assert.deepEqual(roots.params.dirs, ['~/Documents/notes', '/Volumes/x'])
  assert.equal(normPath('~/a/./b/../c'), '~/a/c')
  assert.throws(() => cleanDir('~/'), /家目录/)
  assert.throws(() => cleanDir('relative/dir'), /绝对路径/)
})

test('WS：流式调用的 chunk、tool / tool-result、cancel；fs-dirs 接口', async () => {
  const { pf, host } = make()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', (d) => { body += d })
    await new Promise((r) => req.on('end', r))
    if (!(await pf.handle(req, res, url, async () => JSON.parse(body || '{}')))) { res.writeHead(404); res.end() }
  })
  server.on('upgrade', (req, socket, head) => pf.upgrade(req, socket, head, new URL(req.url, 'http://x')))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/platform/ws?client=test-client-1`)
  const got = []
  ws.on('message', (d) => {
    const m = JSON.parse(String(d))
    got.push(m)
    if (m.t === 'prompt') ws.send(JSON.stringify({ t: 'prompt-answer', id: m.id, answer: 'always' }))
    if (m.t === 'tool') ws.send(JSON.stringify({ t: 'tool-result', id: m.id, rid: m.rid, ok: true, value: { sum: m.args.a + m.args.b } }))
  })
  await new Promise((r) => ws.on('open', r))
  const wait = (fn) => new Promise((res) => { const t = setInterval(() => { const v = got.find(fn); if (v) { clearInterval(t); res(v) } }, 5) })
  ws.send(JSON.stringify({ t: 'call', id: 1, plugin: 'hello', method: 'ai.chat', stream: true, args: { messages: [{ role: 'user', content: 'hi' }] } }))
  const r1 = await wait((m) => m.t === 'result' && m.id === 1)
  assert.deepEqual(r1.value, { role: 'assistant', content: 'Hello' })
  assert.deepEqual(got.filter((m) => m.t === 'chunk' && m.id === 1).map((m) => m.data.content), ['He', 'llo'])
  ws.send(JSON.stringify({ t: 'call', id: 2, plugin: 'hello', method: 'ai.chat', stream: true, args: { messages: [{ role: 'user', content: 'tool' }], tools: [{ type: 'function', function: { name: 'add' } }] } }))
  const r2 = await wait((m) => m.t === 'result' && m.id === 2)
  assert.equal(r2.value.content, 'sum=5')
  assert.deepEqual(got.find((m) => m.t === 'tool').name, 'add')
  ws.send(JSON.stringify({ t: 'call', id: 3, plugin: 'hello', method: 'ai.chat', stream: true, args: { messages: [{ role: 'user', content: 'hang' }] } }))
  await new Promise((r) => setTimeout(r, 50))
  ws.send(JSON.stringify({ t: 'cancel', id: 3 }))
  const r3 = await wait((m) => m.t === 'result' && m.id === 3)
  assert.deepEqual([r3.ok, r3.error.code], [false, 'aborted'])
  assert.equal(host.streams[2].cancelled, true)
  ws.close()
  // fs-dirs：设置页用的接口
  const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()])
  assert.deepEqual(await post('/api/plugins/fs-dirs', { plugin: 'hello', dirs: ['~/Notes', '~/Notes/'] }), [200, { dirs: ['~/Notes'], private: '~/.local/share/pane-remote/plugins-data/hello' }])
  assert.equal((await post('/api/plugins/fs-dirs', { plugin: 'hello', dirs: ['/'] }))[0], 400)
  const g = await (await fetch(`http://127.0.0.1:${port}/api/plugins/fs-dirs?plugin=hello`)).json()
  assert.deepEqual(g.dirs, ['~/Notes'])
  server.close()
})
