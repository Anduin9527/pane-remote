#!/usr/bin/env node
// pane-remote MCP 的启动器（agent 配置里启动的就是这个文件）：真正的服务是同目录的 mcp-server.mjs，跑在子进程里，
// 这里只转发 stdio。mcp-server.mjs 换了（install.sh 重装）就热替换，agent 这边连接不断、不用 /mcp 重连：
//   1. 起一个新的子进程，把 agent 当初发的 initialize（换个 id，回复吞掉）和 initialized 重放给它
//   2. 它回了 initialize 才切过去：之后的请求都发给新的；旧的关掉 stdin，处理完手上的请求自己退出
//   3. 告诉 agent 工具列表变了（tools/list_changed），agent 重新拉
// 新的 5 秒内没回 initialize（代码有错）就丢掉它，继续用旧的。子进程意外退出也按同样的方式拉一个新的。
// 这个文件要尽量少改：它自己换了，已经在跑的会话还是得重连一次才用上。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMPL = path.join(HERE, 'mcp-server.mjs')
const write = (m) => process.stdout.write(typeof m === 'string' ? m + '\n' : JSON.stringify(m) + '\n')
const note = (s) => process.stderr.write(`pane-remote mcp: ${s}\n`)

let initReq = null // agent 发的 initialize（重放用）
let initialized = null // 它之后发的 notifications/initialized
let cur = null // 当前的子进程
let swaps = 0
let closing = false
let restarts = [] // 最近一分钟意外退出的时间

function lines(stream, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l) }
  })
}

/** 起一个子进程。replay：重放 initialize，回复吞掉，回了才 resolve */
function start(replay) {
  const c = spawn(process.execPath, [IMPL], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
  const swapId = `__pane_remote_swap_${++swaps}`
  let resolveReady
  c.ready = new Promise((r) => { resolveReady = r })
  c.stdin.on('error', () => {}) // ignore: 子进程退出后还在写
  lines(c.stdout, (l) => {
    if (replay && l.includes(swapId)) { try { if (JSON.parse(l).id === swapId) return resolveReady(true) } catch {} } // ignore: 不是 JSON 就照常转发
    write(l)
  })
  c.on('exit', (code, sig) => {
    resolveReady(false)
    if (c !== cur || closing) return
    // 意外退出：拉一个新的接上（重放 initialize），太频繁就不拉了
    note(`server exited (${sig || code}), restarting`)
    cur = null
    const now = Date.now()
    restarts = restarts.filter((t) => now - t < 60000)
    if (restarts.length >= 5) { note('restarting too often, giving up'); process.exit(1) }
    restarts.push(now)
    swap(true)
  })
  if (replay) {
    c.stdin.write(JSON.stringify({ ...initReq, id: swapId }) + '\n')
    if (initialized) c.stdin.write(initialized + '\n')
  }
  return c
}

async function swap(crashed = false) {
  if (!initReq) return // 还没初始化：下一个子进程从头来就行
  const next = start(true)
  const ok = await Promise.race([next.ready, new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!ok) {
    note('new server did not initialize, keeping the old one')
    try { next.kill() } catch {} // ignore: 已经退了
    if (crashed && !cur) process.exit(1)
    return
  }
  const old = cur
  cur = next
  // 旧的关掉 stdin：它把手上的请求回完自己退出（mcp-server.mjs 里的 inflight），10 分钟兜底
  if (old) { try { old.stdin.end() } catch {} setTimeout(() => { try { old.kill() } catch {} }, 600000).unref() } // ignore: 已经退了
  write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  note(crashed ? 'server restarted' : 'server code updated, swapped')
}

cur = start(false)
lines(process.stdin, (l) => {
  try {
    const m = JSON.parse(l)
    if (m.method === 'initialize' && m.id !== undefined) initReq = m
    else if (m.method === 'notifications/initialized') initialized = l
  } catch {} // ignore: 解析不了的照样交给子进程，它会回 parse error
  try { cur?.stdin.write(l + '\n') } catch {} // ignore: 正在切换，子进程刚退出
})
process.stdin.on('end', () => {
  closing = true
  if (!cur) process.exit(0)
  cur.on('exit', () => process.exit(0))
  cur.stdin.end()
})
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { closing = true; try { cur?.kill(s) } catch {} process.exit(0) }) // ignore: 子进程已经退了

// mcp-server.mjs 换了就热替换（install.sh 用 rsync：写临时文件再改名，盯目录）
let sig = ''
const stamp = () => { try { const st = fs.statSync(IMPL); return `${st.size}:${st.mtimeMs}` } catch { return '' } }
sig = stamp()
let timer = null
try {
  fs.watch(HERE, (ev, name) => {
    if (name && name !== 'mcp-server.mjs') return
    clearTimeout(timer)
    timer = setTimeout(() => { const s = stamp(); if (s && s !== sig) { sig = s; swap() } }, 800)
  }).on('error', () => {}) // ignore: 目录没了（卸载），继续用当前的
} catch {} // ignore: 不支持 watch 就不热替换
