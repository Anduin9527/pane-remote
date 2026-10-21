// pane-host 的 AI / 文件 / 桌面能力：真的 pane-host（假 Host）+ 真的 HostClient，AI 换成假的 claude 脚本（不调真模型）。
// 假 claude 由 host-env 文件的 PATH 指过去（顺带验证 pane-host 读 host-env 交给 AI 子进程）：
//   输入里有 HANG 就一直不出声（测取消）；有 TOOL 就按 --mcp-config 拉起临时 MCP、调一次工具，把结果写进文件，再回放录制的输出。
// 跑：node --test host/test/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HostClient } from '../../server/host-client.mjs'
import { ERR } from '../protocol.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const FX = path.join(ROOT, 'host/ai/test/fixtures')
// unix socket 路径有长度上限（104 字节），放短的 TMPDIR 下
const TMP = fs.mkdtempSync(path.join(process.env.PANE_HOST_TEST_TMP || os.tmpdir(), 'ph-ai-'))
const BIN = path.join(TMP, 'bin')
const STATE = path.join(TMP, 'state')
const OPENED = path.join(TMP, 'opened.txt')
const DATA = path.join(TMP, 'plugins-data')
fs.mkdirSync(BIN)
fs.mkdirSync(STATE)
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('fs')
const { spawn } = require('child_process')
const argv = process.argv.slice(2)
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0) }
let buf = ''
process.stdin.on('data', (d) => { buf += d })
process.stdin.on('end', async () => {
  if (buf.includes('HANG')) { fs.writeFileSync(${JSON.stringify(path.join(BIN, 'hang-pid'))}, String(process.pid)); return setInterval(() => {}, 1000) }
  if (buf.includes('TOOL')) {
    const cfg = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers.wt
    const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    const got = new Promise((r) => mcp.stdout.on('data', (d) => { out += d; const l = out.split('\\n').filter(Boolean).map((x) => JSON.parse(x)).find((m) => m.id === 2); if (l) r(l) }))
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n')
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } }) + '\\n')
    const r = await got
    fs.writeFileSync(${JSON.stringify(path.join(BIN, 'tool-result'))}, JSON.stringify(r.result))
    mcp.kill()
  }
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FX, 'claude-basic.jsonl'))}, 'utf8'))
})
`, { mode: 0o755 })
const ENV_FILE = path.join(TMP, 'host-env')
fs.writeFileSync(ENV_FILE, `# 测试\nPATH=${BIN}:/usr/bin:/bin\nexport HTTPS_PROXY="http://user:secret@127.0.0.1:9"\n`, { mode: 0o600 })
const ENV = {
  ...process.env, PANE_HOST_DIR: path.join(TMP, 'run'), PANE_REMOTE_STATE: STATE, PANE_HOST_IMPL: path.join(HERE, 'fake-host.mjs'),
  PANE_HOST_ENV_FILE: ENV_FILE, PANE_HOST_AI_PROVIDERS: 'claude', PANE_HOST_PLUGINS_DATA: DATA, FAKE_OPENED: OPENED, PANE_HOST_IDLE_EXIT_MS: '5000',
}

let daemon
const client = new HostClient({
  spawn: () => spawn(process.execPath, [path.join(ROOT, 'host/connect.mjs')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] }),
  log: () => {},
})
before(async () => {
  // 自己起 pane-host（不经 connect 就地拉起），日志接到这里，好检查 host-env 的值没被打印
  daemon = spawn(process.execPath, [path.join(ROOT, 'host/main.mjs')], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.log = ''
  daemon.stdout.on('data', (d) => { daemon.log += d })
  daemon.stderr.on('data', (d) => { daemon.log += d })
  for (let i = 0; i < 50 && !fs.existsSync(path.join(TMP, 'run/host.sock')); i++) await new Promise((r) => setTimeout(r, 100))
  client.start()
  await new Promise((r) => client.once('up', r))
})
after(async () => {
  client.stop()
  daemon.kill('SIGTERM')
  await new Promise((r) => daemon.once('close', r))
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('host-env：变量名进日志，值不打印；ping 带 home 和能力', async () => {
  assert.match(daemon.log, /host-env: PATH, HTTPS_PROXY/)
  assert.ok(!daemon.log.includes('secret'), '值不能出现在日志里')
  const p = await client.call('ping')
  assert.equal(p.home, os.homedir())
  assert.deepEqual(p.caps, ['ai', 'fs', 'desktop'])
})

test('ai.models：经 host-env 的 PATH 找到假 claude，带 efforts / tier / vision', async () => {
  const { models, skipped } = await client.call('ai.models', {}, { timeout: 30000 })
  assert.deepEqual(skipped, {})
  const h = models.find((m) => m.id === 'claude/haiku')
  assert.ok(h && h.vision === true && h.tier === 'fast' && Array.isArray(h.efforts))
  assert.ok(models.find((m) => m.id === 'claude/sonnet').efforts.includes('high'))
})

test('ai.complete：流式片段拼起来等于回答；advanced 带耗时和模型', async () => {
  const chunks = []
  const s = client.stream('ai.complete', { req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }] } }, (c) => chunks.push(c))
  const msg = await s.done
  assert.deepEqual(msg, { role: 'assistant', content: "Hey, what's up?" })
  assert.ok(chunks.length > 0 && chunks.every((c) => c.type === 'chunk'))
  assert.equal(chunks.map((c) => c.data.content).join(''), msg.content)
  const r = await client.stream('ai.complete', { req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }] }, advanced: true }, () => {}).done
  assert.equal(r.model, 'claude/haiku')
  assert.equal(typeof r.ms, 'number')
  await assert.rejects(client.stream('ai.complete', { req: { model: 'claude/haiku@ultra', messages: [{ role: 'user', content: 'x' }] } }, () => {}).done, (e) => e.code === 'model')
  await assert.rejects(client.stream('ai.complete', { req: {} }, () => {}).done, (e) => e.code === 'input')
})

test('ai.complete 取消：流以 CANCELLED 结束，假 claude 进程被杀', async () => {
  const s = client.stream('ai.complete', { req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'HANG please' }] } }, () => {})
  await new Promise((r) => setTimeout(r, 500))
  s.cancel()
  await assert.rejects(s.done, (e) => e.code === ERR.CANCELLED)
  // 备用进程会预先起好，接手 HANG 请求的那个自己记下 PID
  const pid = Number(fs.readFileSync(path.join(BIN, 'hang-pid'), 'utf8'))
  await new Promise((r) => setTimeout(r, 300))
  assert.throws(() => process.kill(pid, 0), '取消后 claude 子进程应该已经退出')
})

test('ai.complete 工具调用：流里发 tool-call 请求，reply 的结果回到 agent', async () => {
  const seen = []
  let s
  s = client.stream('ai.complete', {
    req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'TOOL add 2 and 3' }], tools: [{ type: 'function', function: { name: 'add', description: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } } }] },
  }, (c) => {
    if (c.type !== 'tool-call') return
    seen.push(c)
    s.reply(c.rid, { ok: true, value: { sum: c.args.a + c.args.b } })
  })
  await s.done
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'add')
  const r = JSON.parse(fs.readFileSync(path.join(BIN, 'tool-result'), 'utf8'))
  assert.deepEqual(JSON.parse(r.content[0].text), { sum: 5 })
})

test('desktop：剪贴板读写、打开网址只认 http(s)', async () => {
  assert.equal(await client.call('desktop.clipboard.readText'), 'fake clipboard')
  await client.call('desktop.clipboard.writeText', { text: '你好' })
  assert.equal(await client.call('desktop.clipboard.readText'), '你好')
  await client.call('desktop.openUrl', { url: 'https://example.com/a' })
  assert.equal(fs.readFileSync(OPENED, 'utf8'), 'https://example.com/a\n')
  await assert.rejects(client.call('desktop.openUrl', { url: 'file:///etc/passwd' }), (e) => e.code === ERR.PARAMS)
})

test('fs：私有目录自动建、只读、不许越界；额外目录按真实路径核对', async () => {
  const roots = await client.call('fs.roots', { plugin: 'demo', dirs: [TMP] })
  assert.equal(roots[0].path, fs.realpathSync(path.join(DATA, 'demo')))
  assert.equal(roots[1].exists, true)
  fs.writeFileSync(path.join(DATA, 'demo/a.txt'), '你好')
  assert.deepEqual((await client.call('fs.list', { plugin: 'demo', root: 'private' })).map((e) => [e.name, e.type]), [['a.txt', 'file']])
  assert.deepEqual(await client.call('fs.read', { plugin: 'demo', root: 'private', path: 'a.txt' }), { data: '你好', encoding: 'utf8', size: 6, truncated: false })
  assert.equal((await client.call('fs.read', { plugin: 'demo', root: 'private', path: 'a.txt', encoding: 'base64', maxBytes: 3 })).truncated, true)
  await assert.rejects(client.call('fs.read', { plugin: 'demo', root: 'private', path: '../../host-env' }), (e) => e.code === 'EWTPERM')
  // 私有目录里放一个指向外面的符号链接：按真实路径算，越界
  fs.symlinkSync(ENV_FILE, path.join(DATA, 'demo/link'))
  await assert.rejects(client.call('fs.read', { plugin: 'demo', root: 'private', path: 'link' }), (e) => e.code === 'EWTPERM')
  // 用户加的目录：可以读里面的，按绝对路径也行
  assert.equal((await client.call('fs.stat', { plugin: 'demo', root: TMP, path: ENV_FILE })).type, 'file')
  await assert.rejects(client.call('fs.list', { plugin: 'demo', root: TMP, path: '/etc' }), (e) => e.code === 'EWTPERM')
  await assert.rejects(client.call('fs.list', { plugin: '../x', root: 'private' }), (e) => e.code === 'EBADARG')
})

test('取消、工具调用之后 pane-host 照常回应', async () => {
  execFileSync('/bin/kill', ['-0', String(daemon.pid)])
  assert.equal((await client.call('ping')).pong, true)
})
