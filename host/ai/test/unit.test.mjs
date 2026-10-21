// 单元测试（不调用任何真模型）：node --test host/ai/test/
// 参数构造、输出解析用录制的真实输出（fixtures/），常驻进程 / 取消用一个假的 claude 脚本
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, toText, toClaudeContent, images } from '../messages.mjs'
import { splitModelId, resolveModel, schemaOf, parseJson, createAi } from '../index.mjs'
import * as claude from '../providers/claude.mjs'
import * as codex from '../providers/codex.mjs'
import * as cursor from '../providers/cursor.mjs'
import { startToolBridge, mcpTools, MCP_SCRIPT } from '../toolbridge.mjs'
import { agentEnv } from '../env.mjs'

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fx = (f) => fs.readFileSync(path.join(FX, f), 'utf8')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('messages: OpenAI / Anthropic 两种图片写法、system 拼接', () => {
  const n = normalize([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } }] },
  ])
  assert.equal(n.system, 'Be brief.')
  assert.equal(images(n).length, 2)
  assert.equal(images(n)[1].mediaType, 'image/jpeg')
  assert.equal(toText(n), 'what is this\n[image 1]\n[image 2]')
  const c = toClaudeContent(n)
  assert.deepEqual(c.map((b) => b.type), ['text', 'image', 'image'])
  assert.equal(c[1].source.media_type, 'image/png')
})

test('messages: 多轮压成对话记录', () => {
  const n = normalize([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }])
  const t = toText(n)
  assert.match(t, /<User>\nhi\n<\/User>\n\n<Assistant>\nhello\n<\/Assistant>\n\n<User>\nagain\n<\/User>$/)
  assert.equal(toClaudeContent(n)[0].type, 'text')
})

test('模型 ID：@推理等级、cursor 原始 id、claude 精确 id', () => {
  assert.deepEqual(splitModelId('codex/gpt-6-luna@low'), { base: 'codex/gpt-6-luna', effort: 'low' })
  const list = [
    { id: 'claude/haiku', provider: 'claude', model: 'haiku', efforts: [] },
    { id: 'codex/gpt-6-luna', provider: 'codex', model: 'gpt-6-luna', efforts: ['low', 'medium'], defaultEffort: 'medium' },
    ...cursor.parseModels(fx('cursor-models.txt')).map((m) => ({ ...m, id: `cursor/${m.model}`, provider: 'cursor' })),
  ]
  assert.equal(resolveModel(list, 'codex/gpt-6-luna@low').effort, 'low')
  assert.throws(() => resolveModel(list, 'codex/gpt-6-luna@ultra'), /不支持推理等级/)
  assert.throws(() => resolveModel(list, 'nope/x'), /没有这个模型/)
  assert.equal(resolveModel(list, 'cursor/claude-opus-5-5@high').native, 'claude-opus-5-5-high')
  assert.equal(resolveModel(list, 'cursor/claude-opus-5-5').native, 'claude-opus-5-5-medium')
  assert.equal(resolveModel(list, 'cursor/claude-opus-5-5-low-fast').native, 'claude-opus-5-5-low-fast')
  assert.equal(resolveModel(list, 'cursor/composer-2.5-fast').native, 'composer-2.5-fast')
  assert.equal(resolveModel(list, 'claude/claude-haiku-4-5-20251001').native, 'claude-haiku-4-5-20251001')
})

test('cursor --list-models：推理等级合并、名字整理、档位', () => {
  const ms = cursor.parseModels(fx('cursor-models.txt'))
  const o = ms.find((m) => m.model === 'claude-opus-5-5')
  assert.deepEqual(o.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(o.label, 'Claude Opus 5.5 1M')
  assert.equal(ms.find((m) => m.model === 'composer-2.5').label, 'Composer 2.5')
  assert.equal(ms.find((m) => m.model === 'gemini-3.1-pro').tier, 'balanced') // gemini 里的 mini 不算
  assert.equal(cursor.cheapest(ms).model, 'composer-2.5-fast')
})

test('codex 模型缓存：只要 visibility=list，带推理等级', () => {
  const ms = codex.readModels(path.join(FX, 'codex-models.json'))
  assert.ok(!ms.some((m) => m.model === 'gpt-reserve'))
  const l = ms.find((m) => m.model === 'gpt-5.6-luna')
  assert.equal(l.tier, 'fast')
  assert.ok(l.efforts.includes('low') && l.vision)
})

test('responseFormat / JSON 提取', () => {
  const s = { type: 'object', properties: { a: { type: 'number' } } }
  assert.deepEqual(schemaOf({ type: 'json_schema', json_schema: { name: 'x', schema: s } }), s)
  assert.deepEqual(schemaOf(s), s)
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJson('Sure: {"a":2} done'), { a: 2 })
  assert.equal(parseJson('no json'), undefined)
})

test('claude：参数（不用 --bare，空工具、不留会话）和输出解析', () => {
  const a = claude.buildArgs({ model: 'haiku', system: 'S', schema: { type: 'object' }, mcpConfig: '{}', effort: 'low' })
  assert.ok(!a.includes('--bare'))
  for (const f of ['--no-session-persistence', '--strict-mcp-config', '--include-partial-messages', '--disable-slash-commands']) assert.ok(a.includes(f), f)
  assert.equal(a[a.indexOf('--tools') + 1], '')
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project')
  assert.equal(a[a.indexOf('--json-schema') + 1], '{"type":"object"}')
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'mcp__wt')
  assert.equal(a[a.indexOf('--effort') + 1], 'low')
  // 变长参数（--tools / --mcp-config / --allowedTools）后面必须紧跟另一个选项
  for (const f of ['--tools', '--mcp-config', '--allowedTools']) { const i = a.indexOf(f); assert.ok(i + 2 >= a.length || a[i + 2].startsWith('--'), f) }
  const chunks = []
  const p = claude.createParser({ onText: (t) => chunks.push(t) })
  for (const l of fx('claude-basic.jsonl').split('\n')) p.feed(l)
  assert.equal(chunks.join(''), "Hey, what's up?")
  assert.ok(chunks.length > 1, '应该是逐字增量')
  assert.equal(p.model, 'claude-haiku-4-5-20251001')
  assert.equal(claude.usageOf(p.result).outputTokens, 131)
})

test('codex：参数顺序（-i 在前、- 在最后）和输出解析', () => {
  const a = codex.buildArgs({ model: 'gpt-5.6-luna', effort: 'low', cwd: '/tmp/w', imageFiles: ['/tmp/a.png'], schemaFile: '/tmp/s.json' })
  assert.deepEqual(a.slice(0, 3), ['exec', '-i', '/tmp/a.png'])
  assert.equal(a.at(-1), '-')
  assert.ok(a.includes('--ephemeral') && a.includes('--ignore-user-config') && a.includes('--output-schema'))
  assert.ok(a.includes('model_reasoning_effort="low"'))
  assert.equal(a[a.indexOf('-s') + 1], 'read-only')
  const p = codex.createParser()
  for (const l of fx('codex-basic.jsonl').split('\n')) p.feed(l)
  assert.equal(p.text, '你好，朋友！')
  assert.ok(p.done)
  assert.equal(codex.usageOf(p.usage).outputTokens, 8)
  const q = codex.createParser()
  q.feed('{"type":"turn.failed","error":{"message":"boom"}}')
  assert.equal(q.error, 'boom')
})

test('cursor：参数和输出解析（最后那条整段不重复）', () => {
  const a = cursor.buildArgs({ model: 'composer-2.5-fast', cwd: '/tmp/w', prompt: 'hi' })
  assert.ok(a.includes('--stream-partial-output') && a.includes('--trust'))
  assert.equal(a[a.indexOf('--mode') + 1], 'ask')
  assert.equal(a.at(-1), 'hi')
  const chunks = []
  const reasoning = []
  const p = cursor.createParser({ onText: (t) => chunks.push(t), onReasoning: (t) => reasoning.push(t) })
  for (const l of fx('cursor-basic.jsonl').split('\n')) p.feed(l)
  assert.equal(chunks.join(''), 'Hi there friend.')
  assert.ok(reasoning.join('').length > 0)
  assert.equal(cursor.usageOf(p.result).outputTokens, 39)
})

test('env：去掉父会话变量，配置目录沿用环境或 opts', () => {
  const e = agentEnv({ baseEnv: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', PATH: '/bin', FOO: 'bar' }, triageEnvFile: '/nonexistent' })
  assert.equal(e.CLAUDECODE, undefined)
  assert.equal(e.CLAUDE_CODE_SESSION_ID, undefined)
  assert.equal(e.FOO, 'bar')
  assert.equal(e.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(agentEnv({ baseEnv: { CLAUDE_CONFIG_DIR: '/tmp/cc' }, triageEnvFile: '/nonexistent' }).CLAUDE_CONFIG_DIR, '/tmp/cc')
  assert.equal(agentEnv({ baseEnv: {}, claudeConfigDir: '/tmp/x', triageEnvFile: '/nonexistent' }).CLAUDE_CONFIG_DIR, '/tmp/x')
})

// MCP 客户端（模拟 agent）：起 tool-mcp.mjs，按行收发 JSON-RPC
function mcpClient(env) {
  const p = spawn(process.execPath, [MCP_SCRIPT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''
  const waiting = new Map()
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m) }
  })
  let id = 0
  return {
    req: (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') }),
    close: () => p.stdin.end(),
  }
}

test('临时 MCP：tools/list 和 tools/call 回调到 callTool', async () => {
  const tools = [{ type: 'function', function: { name: 'add', description: 'add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } } },
    { type: 'function', function: { name: 'fail', description: 'always fails', parameters: { type: 'object', properties: {} } } }]
  const seen = []
  const tb = await startToolBridge(tools, { callTool: async (name, args) => { seen.push(name); if (name === 'fail') throw new Error('nope'); return { sum: args.a + args.b } } })
  const c = mcpClient(tb.env)
  try {
    const init = await c.req('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(init.result.serverInfo.name, 'wt')
    const l = await c.req('tools/list', {})
    assert.deepEqual(l.result.tools.map((t) => t.name), ['add', 'fail'])
    const r = await c.req('tools/call', { name: 'add', arguments: { a: 2, b: 3 } })
    assert.equal(r.result.content[0].text, '{"sum":5}')
    const f = await c.req('tools/call', { name: 'fail', arguments: {} })
    assert.equal(f.result.isError, true)
    assert.equal(f.result.content[0].text, 'nope')
    assert.deepEqual(seen, ['add', 'fail'])
    assert.equal(tb.calls.length, 2)
    assert.ok(JSON.parse(tb.claudeConfig()).mcpServers.wt.env.AI_TOOLS_SOCK)
    assert.ok(tb.codexArgs().some((x) => x.startsWith('mcp_servers.wt.env={AI_TOOLS_FILE=')))
  } finally { c.close(); tb.close() }
  assert.ok(!fs.existsSync(tb.dir), '临时目录要删掉')
  assert.throws(() => mcpTools([{ type: 'function', function: { name: 'bad name' } }]), /工具名不合法/)
})

// 假 claude：读一行 stdin，回放录制的输出；FAKE_HANG=1 时什么都不输出，一直等
function fakeBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  const f = path.join(dir, 'claude')
  fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs')
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0) }
fs.appendFileSync(${JSON.stringify(path.join(dir, 'starts'))}, process.pid + '\\n')
let buf = ''
process.stdin.on('data', (d) => { buf += d })
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'inputs'))}, buf)
  if (process.env.FAKE_HANG) return setInterval(() => {}, 1000)
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FX, 'claude-basic.jsonl'))}, 'utf8'))
})
`, { mode: 0o755 })
  return dir
}

test('claude 常驻备用进程：第二次请求接手预先起好的进程；取消按进程组杀', async () => {
  const dir = fakeBin()
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-'))
  const ai = createAi({ providers: ['claude'], cacheDir: cache, env: { PATH: `${dir}:/usr/bin:/bin` } })
  try {
    const chunks = []
    const r1 = await ai.completeAdvanced({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }] }, { onChunk: (c) => chunks.push(c.content) })
    assert.equal(r1.text, "Hey, what's up?")
    assert.equal(chunks.join(''), "Hey, what's up?")
    assert.equal(r1.warm, false)
    assert.equal(r1.nativeModel, 'claude-haiku-4-5-20251001')
    await new Promise((r) => setTimeout(r, 300))
    const r2 = await ai.completeAdvanced({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hi again' }] })
    assert.equal(r2.warm, true)
    const inputs = fs.readFileSync(path.join(dir, 'inputs'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(inputs[1].message.content[0].text, 'hi again')
    // 多一个 system 提示 = 另一组参数，不能用前面的备用进程
    const msg = await ai.complete({ model: 'claude/haiku', messages: [{ role: 'system', content: 'other' }, { role: 'user', content: 'x' }] })
    assert.deepEqual(msg, { role: 'assistant', content: "Hey, what's up?" })
  } finally { ai.close() }

  const ai2 = createAi({ providers: ['claude'], cacheDir: cache, warm: false, env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_HANG: '1' } })
  const ac = new AbortController()
  const p = ai2.completeAdvanced({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hang' }] }, { signal: ac.signal })
  setTimeout(() => ac.abort(), 400)
  await assert.rejects(p, (e) => e.code === 'aborted')
  const pid = Number(fs.readFileSync(path.join(dir, 'starts'), 'utf8').trim().split('\n').at(-1))
  await new Promise((r) => setTimeout(r, 200))
  assert.throws(() => process.kill(pid, 0), '取消后子进程应该已经退出')
  const r3 = createAi({ providers: ['claude'], cacheDir: cache, warm: false, timeoutMs: 300, env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_HANG: '1' } })
  await assert.rejects(r3.completeAdvanced({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hang' }] }), (e) => e.code === 'timeout')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
})

test('cursor 看图转译：先让 claude/haiku 描述图片，再把文字交给 cursor；cursor 不支持工具', async () => {
  const dir = fakeBin()
  const f = path.join(dir, 'cursor-agent')
  fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs')
const a = process.argv.slice(2)
if (a[0] === 'status') { console.log('Logged in as test'); process.exit(0) }
if (a[0] === '--list-models') { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FX, 'cursor-models.txt'))}, 'utf8')); process.exit(0) }
fs.writeFileSync(${JSON.stringify(path.join(dir, 'cursor-prompt'))}, a.at(-1))
process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(FX, 'cursor-basic.jsonl'))}, 'utf8'))
`, { mode: 0o755 })
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cache-'))
  const ai = createAi({ providers: ['claude', 'cursor'], cacheDir: cache, warm: false, env: { PATH: `${dir}:/usr/bin:/bin` } })
  try {
    const ms = await ai.models()
    assert.equal(ms.find((m) => m.id === 'cursor/composer-2.5-fast').vision, 'bridged')
    const r = await ai.completeAdvanced({ model: 'cursor/composer-2.5-fast', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is it' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }] })
    assert.equal(r.text, 'Hi there friend.')
    assert.equal(r.bridge.model, 'claude/haiku')
    const sent = JSON.parse(fs.readFileSync(path.join(dir, 'inputs'), 'utf8').trim().split('\n').at(-1))
    assert.ok(sent.message.content.some((b) => b.type === 'image'), '转译请求要带原图')
    const prompt = fs.readFileSync(path.join(dir, 'cursor-prompt'), 'utf8')
    assert.match(prompt, /^Do not use any tools/)
    assert.match(prompt, /converted to text by claude\/haiku/)
    assert.match(prompt, /Hey, what's up\?/) // 假 claude 的「描述」被放进了提示
    await assert.rejects(ai.completeAdvanced({ model: 'cursor/composer-2.5-fast', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 't', description: '', parameters: {} } }] }), (e) => e.code === 'tools')
  } finally { ai.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }) }
})
