// pane-host 的集成测试：用假 Host（test/fake-host.mjs）起一个真的 pane-host（临时目录里的 socket），
// 服务端侧用真的 HostClient、经真的 connect.mjs 连（第一次连时由 connect 就地拉起 pane-host）。
// 事件用真的 agent/pane-event 写（HOME 指到临时目录），包括它的截断逻辑。跑：node --test host/test/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HostClient } from '../../server/host-client.mjs'
import { Feed } from '../protocol.mjs'
import { diff, apply } from '../delta.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const TMP = fs.mkdtempSync(path.join(process.env.PANE_HOST_TEST_TMP || os.tmpdir(), 'pane-host-test-'))
const STATE = path.join(TMP, '.local/state/pane-remote')
const EVENTS = path.join(STATE, 'events.jsonl')
const TRANSCRIPT = path.join(TMP, 'session.jsonl')
fs.mkdirSync(STATE, { recursive: true })
fs.writeFileSync(TRANSCRIPT, '')
const ENV = { ...process.env, PANE_HOST_DIR: path.join(TMP, 'run'), PANE_REMOTE_STATE: STATE, PANE_HOST_IMPL: path.join(HERE, 'fake-host.mjs'), FAKE_TRANSCRIPT: TRANSCRIPT, PANE_HOST_IDLE_EXIT_MS: '5000' }

let connectors = []
const client = new HostClient({
  spawn: () => {
    const p = spawn(process.execPath, [path.join(ROOT, 'host/connect.mjs')], { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] })
    connectors.push(p)
    return p
  },
  log: () => {},
  pingMs: 1000,
  pingTimeout: 1000,
  maxBackoff: 400,
})
client.backoff = 200
const waitFor = async (fn, ms = 3000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timeout')
}
// 用真的 pane-event 写一条事件（HOME 指向临时目录，它就写临时目录里的 events.jsonl）
const writeEvent = (kind, msg) => execFileSync('/usr/bin/python3', [path.join(ROOT, 'agent/pane-event'), kind], { env: { ...process.env, HOME: TMP, WEZTERM_PANE: '7' }, input: JSON.stringify({ message: msg, cwd: '/tmp' }) })

before(async () => {
  client.start()
  await new Promise((r) => client.once('up', r))
})
after(async () => {
  client.stop()
  // 测试里拉起的 pane-host：按 socket 问出 PID 再按 PID 结束
  try {
    const pid = Number(execFileSync('/usr/sbin/lsof', ['-t', path.join(TMP, 'run/host.sock')]).toString().trim().split('\n')[0])
    if (pid) process.kill(pid, 'SIGTERM')
  } catch {} // ignore: pane-host 已经自己退出了
  await new Promise((r) => setTimeout(r, 200))
  fs.rmSync(TMP, { recursive: true, force: true })
})

test('feed: 序号对得上补发，太旧给 reset', () => {
  const f = new Feed({ ring: 3, snapshot: () => 'ALL' })
  const s0 = f.seq
  for (let i = 0; i < 5; i++) f.publish(i)
  const got = []
  f.attach((e) => got.push(e), s0 + 3)
  assert.deepEqual(got.map((e) => [e.event, e.data]), [['data', 3], ['data', 4]])
  const got2 = []
  f.attach((e) => got2.push(e), s0)
  assert.deepEqual(got2.map((e) => [e.event, e.data]), [['reset', 'ALL']])
})

test('delta: 窗口滑动、最后一条变化', () => {
  const a = [{ id: 1 }, { id: 2 }, { id: 3, p: 'x' }]
  const b = [{ id: 2 }, { id: 3, p: 'xy' }, { id: 4 }]
  const d = diff(a, b)
  assert.deepEqual(d, { drop: 1, keep: 1, tail: [{ id: 3, p: 'xy' }, { id: 4 }] })
  assert.deepEqual(apply(a, d), b)
  assert.equal(diff(a, [{ id: 9 }]), null)
})

test('call / 错误 / stream + cancel', async () => {
  const r = await client.call('ping')
  assert.equal(r.pong, true)
  await assert.rejects(client.call('nope'), /no such method/)
  const chunks = []
  const s = client.stream('terminals.watch', { pane: 1 }, (c) => chunks.push(c))
  await waitFor(() => chunks.length >= 3, 3000)
  s.cancel()
  await assert.rejects(s.done, /cancelled/)
  const n = chunks.length
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(chunks.length, n, '取消后不再有数据')
  const bad = client.stream('terminals.watch', { pane: 2 }, () => {})
  await assert.rejects(bad.done, /pane gone/)
})

test('events: 推送延迟、断线补发不丢不重、截断后续读', async () => {
  writeEvent('stop', 'before-sub') // 订阅前的：不该收到
  const got = []
  const sub = client.subscribe('events', { onEvent: (e) => got.push(e) })
  await waitFor(() => sub.live)
  // 1) 延迟
  const lat = []
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    writeEvent('stop', `live-${i}`)
    // 写入本身（拉起 python）不算：从文件写完开始计
    const t1 = performance.now()
    await waitFor(() => got.some((e) => e.data?.msg === `live-${i}`), 2000)
    lat.push([performance.now() - t1, t1 - t0])
  }
  const ms = lat.map((x) => x[0]).sort((a, b) => a - b)
  console.log(`events latency (file written → received): median ${ms[5].toFixed(1)}ms, max ${ms[9].toFixed(1)}ms`)
  assert.ok(ms[9] < 1000)
  // 2) 断线：杀掉连接器，断开期间写 5 条，重连后应当正好补回这 5 条
  const before = got.length
  const down = new Promise((r) => client.once('down', r))
  connectors.at(-1).kill('SIGKILL')
  await down
  for (let i = 0; i < 5; i++) writeEvent('notify', `offline-${i}`)
  const t0 = performance.now()
  await new Promise((r) => client.once('up', r))
  await waitFor(() => got.filter((e) => /^offline-/.test(e.data?.msg || '')).length >= 5, 3000)
  console.log(`reconnect + replay: ${(performance.now() - t0).toFixed(0)}ms`)
  await new Promise((r) => setTimeout(r, 200))
  const msgs = got.slice(before).map((e) => e.data.msg)
  assert.deepEqual(msgs, ['offline-0', 'offline-1', 'offline-2', 'offline-3', 'offline-4'])
  assert.ok(got.slice(before).every((e) => e.replay))
  assert.ok(!got.some((e) => e.data?.msg === 'before-sub'))
  // 3) 截断：把文件撑过 512KB，下一次 pane-event 会截掉前一半并写 {"base":N}；之后的事件照样按顺序收到、序号继续增
  const pad = JSON.stringify({ t: 0, kind: 'pad', msg: 'x'.repeat(200) }) + '\n'
  fs.appendFileSync(EVENTS, pad.repeat(Math.ceil((530 * 1024 - fs.statSync(EVENTS).size) / pad.length)))
  await waitFor(() => got.filter((e) => e.data?.kind === 'pad').length > 2000, 3000)
  const seqBefore = got.at(-1).seq
  const n0 = got.length
  writeEvent('stop', 'after-trunc-0')
  writeEvent('stop', 'after-trunc-1')
  assert.match(fs.readFileSync(EVENTS, 'utf8').split('\n')[0], /^\{"base": \d+\}$/)
  await waitFor(() => got.some((e) => e.data?.msg === 'after-trunc-1'), 3000)
  const tail = got.slice(n0)
  assert.deepEqual(tail.map((e) => e.data.msg), ['after-trunc-0', 'after-trunc-1'])
  assert.ok(tail[0].seq > seqBefore && tail[1].seq > tail[0].seq)
  // 逻辑偏移和老 bridge 的 events 指令一致：用 bridge 从这个偏移读应该什么都没有
  const out = execFileSync('/bin/bash', [path.join(ROOT, 'agent/bridge')], { env: { ...process.env, HOME: TMP, SSH_ORIGINAL_COMMAND: `events ${tail[1].seq}` } }).toString()
  assert.equal(out.trim(), String(tail[1].seq))
  // 4) 截断后断线再补：从截断前的偏移重连也能接上
  const n1 = got.length
  const down2 = new Promise((r) => client.once('down', r))
  connectors.at(-1).kill('SIGKILL')
  await down2
  writeEvent('stop', 'after-trunc-offline')
  await new Promise((r) => client.once('up', r))
  await waitFor(() => got.some((e) => e.data?.msg === 'after-trunc-offline'), 3000)
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(got.slice(n1).map((e) => e.data.msg), ['after-trunc-offline'])
  sub.close()
})

test('transcript: 订阅拿全量，追加推增量，断线后补发', async () => {
  const add = (id, text) => fs.appendFileSync(TRANSCRIPT, JSON.stringify({ id, text }) + '\n')
  add('m1', 'hello')
  let list = null
  const events = []
  const sub = client.subscribe('transcript:1:3', {
    since: 0,
    onEvent: (e) => {
      events.push(e)
      if (e.event === 'reset' || e.data.full) list = e.data.full
      else list = apply(list, e.data)
    },
  })
  await waitFor(() => list?.length === 1)
  const lat = []
  for (let i = 2; i <= 6; i++) {
    const t0 = performance.now()
    add(`m${i}`, `msg ${i}`)
    await waitFor(() => list?.at(-1)?.id === `m${i}`, 3000)
    lat.push(performance.now() - t0)
  }
  console.log(`transcript latency (append → delta applied): ${lat.map((x) => x.toFixed(0)).join(', ')}ms`)
  assert.deepEqual(list.map((m) => m.id), ['m4', 'm5', 'm6'])
  assert.ok(events.slice(1).every((e) => e.event === 'data' && !e.data.full), '追加只发增量')
  // 断线期间追加，重连后按序号补发
  const down = new Promise((r) => client.once('down', r))
  connectors.at(-1).kill('SIGKILL')
  await down
  add('m7', 'offline')
  await new Promise((r) => setTimeout(r, 300)) // 让 pane-host 先看到变化（断线期间它照样在盯）
  await new Promise((r) => client.once('up', r))
  await waitFor(() => list?.at(-1)?.id === 'm7', 3000)
  assert.deepEqual(list.map((m) => m.id), ['m5', 'm6', 'm7'])
  sub.close()
})
