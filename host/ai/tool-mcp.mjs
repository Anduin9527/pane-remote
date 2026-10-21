#!/usr/bin/env node
// 临时 MCP（stdio，零依赖）：一次 AI 请求起一个，由 agent（claude / codex / cursor-agent）当作 MCP 服务拉起。
// 工具清单从 AI_TOOLS_FILE 读；agent 调用工具时经 unix socket（AI_TOOLS_SOCK，带 AI_TOOLS_TOKEN）
// 转回发起请求的进程，由它调 io.callTool，结果原样回给 agent。请求结束后 socket 关闭，这个进程随 agent 一起退出
import fs from 'node:fs'
import net from 'node:net'

const TOOLS = JSON.parse(fs.readFileSync(process.env.AI_TOOLS_FILE, 'utf8'))
const TOKEN = process.env.AI_TOOLS_TOKEN || ''
const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

// 到发起进程的连接：一条长连接，按 id 对回答
let sock = null
let sbuf = ''
let seq = 0
const waiting = new Map()
function conn() {
  if (sock) return sock
  sock = net.createConnection(process.env.AI_TOOLS_SOCK)
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    sbuf += d
    let i
    while ((i = sbuf.indexOf('\n')) >= 0) {
      const line = sbuf.slice(0, i)
      sbuf = sbuf.slice(i + 1)
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id) } catch {}
    }
  })
  const fail = (e) => { for (const f of waiting.values()) f({ error: `tool bridge closed: ${e?.message || 'closed'}` }); waiting.clear(); sock = null }
  sock.on('error', fail)
  sock.on('close', fail)
  return sock
}
function call(name, args) {
  return new Promise((resolve) => {
    const id = ++seq
    waiting.set(id, resolve)
    conn().write(JSON.stringify({ token: TOKEN, id, name, args }) + '\n')
  })
}

async function handle(m) {
  if (m.id === undefined) return
  if (m.method === 'initialize') {
    return out({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wt', version: '1.0.0' } } })
  }
  if (m.method === 'ping') return out({ id: m.id, result: {} })
  if (m.method === 'tools/list') return out({ id: m.id, result: { tools: TOOLS } })
  if (m.method === 'tools/call') {
    const name = m.params?.name
    if (!TOOLS.some((t) => t.name === name)) return out({ id: m.id, error: { code: -32602, message: `unknown tool ${name}` } })
    const r = await call(name, m.params?.arguments || {})
    if (r.error) return out({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(r.error) }] } })
    return out({ id: m.id, result: { content: [{ type: 'text', text: String(r.text ?? '') }] } })
  }
  out({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { out({ id: null, error: { code: -32700, message: 'parse error' } }); continue }
    handle(m)
  }
})
process.stdin.on('end', () => process.exit(0))
