// Cursor 适配器读消息：Cursor 换过三种存法（会话数据里的消息头 / 记录文件 / 分块消息头），三种都读，哪个新用哪个。
// 用一个假的 HOME（假数据库 + 假记录文件）跑 agent/cursor-agent.mjs，调试端口给一个没人用的，不碰真的 Cursor。
// cursor 模块要 node:sqlite（Node 22.5+）：没有就整个跳过
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const sqlite = await import('node:sqlite').catch(() => null)
if (!sqlite) { test('cursor sources (needs node:sqlite)', { skip: true }, () => {}) }
else {
const { DatabaseSync } = sqlite

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-src-'))
const dbDir = path.join(home, 'Library/Application Support/Cursor/User/globalStorage')
fs.mkdirSync(dbDir, { recursive: true })
const db = new DatabaseSync(path.join(dbDir, 'state.vscdb'))
db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
const put = (k, v) => db.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)').run(k, JSON.stringify(v))
const HOUR = 3600e3
const iso = (ago) => new Date(Date.now() - ago).toISOString()
const head = (bubbleId, type, ago) => ({ bubbleId, type, createdAt: iso(ago) })
function bubbles(id, list) { for (const [bid, type, text, ago] of list) put(`bubbleId:${id}:${bid}`, { bubbleId: bid, type, text, createdAt: iso(ago) }) }
function transcript(id, lines, mtimeAgo) {
  const dir = path.join(home, '.cursor/projects/proj/agent-transcripts', id)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l) + '\n').join(''))
  const t = new Date(Date.now() - mtimeAgo)
  fs.utimesSync(f, t, t)
  return f
}
const tUser = (text) => ({ role: 'user', message: { content: [{ type: 'text', text: `<user_query>${text}</user_query>` }] } })
const tAsst = (text) => ({ role: 'assistant', message: { content: [{ type: 'text', text }] } })

// 1. 老会话：消息头在 composerData 里
put('composerData:inline', { status: 'completed', lastUpdatedAt: Date.now() - 2 * HOUR, fullConversationHeadersOnly: [head('a', 1, 2 * HOUR), head('b', 2, 2 * HOUR)] })
bubbles('inline', [['a', 1, '老问题', 2 * HOUR], ['b', 2, '老回答', 2 * HOUR]])
// 2. 3.26：只有记录文件
put('composerData:transcript', { status: 'completed', lastUpdatedAt: Date.now() - HOUR, fullConversationHeadersOnly: [] })
transcript('transcript', [tUser('记录里的问题'), tAsst('记录里的回答'), { type: 'turn_ended', status: 'success' }], HOUR)
// 3. 3.27：分块消息头；composerData 里的旧列表、记录文件都停在一小时前
put('composerData:chunked', { status: 'aborted', lastUpdatedAt: Date.now() - HOUR, headerLog: { chunkSize: 256, chunkCount: 2 }, fullConversationHeadersOnly: [head('old', 1, HOUR)] })
put('composerConvHeaders:chunked:000000', Array.from({ length: 256 }, (_, i) => head(`c${i}`, 2, HOUR)))
put('composerConvHeaders:chunked:000001', [head('q', 1, 60e3), head('r', 2, 30e3)])
bubbles('chunked', [['old', 1, '旧列表', HOUR], ['q', 1, '新问题', 60e3], ['r', 2, '新回答', 30e3]])
transcript('chunked', [tUser('记录停在这里')], HOUR)
// 4. 数据库停更、记录文件还在写：先用数据库，记录文件新出一分钟以上就换过去
put('composerData:switch', { status: 'completed', lastUpdatedAt: Date.now() - HOUR, headerLog: { chunkSize: 256, chunkCount: 1 } })
put('composerConvHeaders:switch:000000', [head('s1', 1, HOUR), head('s2', 2, HOUR)])
bubbles('switch', [['s1', 1, '库里的问题', HOUR], ['s2', 2, '库里的回答', HOUR]])
const switchFile = transcript('switch', [tUser('库里的问题'), tAsst('库里的回答')], HOUR)

const agent = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../cursor-agent.mjs', import.meta.url))], { env: { ...process.env, HOME: home, CURSOR_DEBUG_PORT: '1' }, stdio: ['pipe', 'pipe', 'ignore'] })
const waiting = []
readline.createInterface({ input: agent.stdout }).on('line', (l) => {
  let m
  try { m = JSON.parse(l) } catch { return }
  if (m.t !== 'messages') return
  const i = waiting.findIndex((w) => w.id === m.id)
  if (i >= 0) waiting.splice(i, 1)[0].resolve(m)
})
function watch(id) {
  return new Promise((resolve, reject) => {
    waiting.push({ id, resolve })
    agent.stdin.write(JSON.stringify({ t: 'watch', id }) + '\n')
    setTimeout(() => reject(new Error(`没收到 ${id} 的消息`)), 5000)
  })
}
const texts = (m) => m.list.filter((x) => x.role === 'user' || x.role === 'assistant').map((x) => x.text)
test.after(() => { agent.kill(); fs.rmSync(home, { recursive: true, force: true }) })

test('old conversations: headers inside composerData', async () => {
  assert.deepEqual(texts(await watch('inline')), ['老问题', '老回答'])
})

test('3.26: transcript file only', async () => {
  assert.deepEqual(texts(await watch('transcript')), ['记录里的问题', '记录里的回答'])
})

test('3.27: chunked headers win over the stale inline list and transcript; only the last two chunks', async () => {
  const m = await watch('chunked')
  assert.deepEqual(texts(m), ['新问题', '新回答'])
  assert.equal(m.list.length <= 200, true)
})

test('switches to the transcript once it is a minute newer than the database', async () => {
  assert.deepEqual(texts(await watch('switch')), ['库里的问题', '库里的回答'])
  fs.appendFileSync(switchFile, JSON.stringify(tUser('只在记录里的新问题')) + '\n')
  fs.utimesSync(switchFile, new Date(), new Date())
  assert.deepEqual(texts(await watch('switch')), ['库里的问题', '库里的回答', '只在记录里的新问题'])
})
}
