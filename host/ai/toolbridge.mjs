// 工具调用的「临时 MCP」：为一次请求开一个 0700 临时目录，放工具清单 + unix socket，
// 生成给各家 agent 的 MCP 配置（都指向 tool-mcp.mjs）。agent 调用工具 → tool-mcp.mjs → socket → 这里 → io.callTool
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tool-mcp.mjs')
export const SERVER = 'wt' // MCP 服务名：Claude 里工具名是 mcp__wt__<name>
const NAME = /^[A-Za-z0-9_-]{1,64}$/

// AiTool（OpenAI 风格）→ MCP 工具定义；也接受 {name, description, parameters | inputSchema}
export function mcpTools(tools) {
  const out = []
  for (const t of tools || []) {
    const f = t?.type === 'function' && t.function ? t.function : t
    if (!f || !NAME.test(String(f.name || ''))) throw new Error(`工具名不合法：${String(f?.name).slice(0, 80)}（只能用字母数字 _ -，最多 64 个字符）`)
    const schema = f.parameters || f.inputSchema || { type: 'object', properties: {} }
    out.push({ name: f.name, description: String(f.description || ''), inputSchema: { type: 'object', ...schema } })
  }
  return out
}

const stringify = (v) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))

export async function startToolBridge(tools, { callTool, onCall, node = process.execPath } = {}) {
  const defs = mcpTools(tools)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-ai-'))
  fs.chmodSync(dir, 0o700)
  const file = path.join(dir, 'tools.json')
  const sockPath = path.join(dir, 's')
  const token = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(file, JSON.stringify(defs))
  const calls = []
  const sockets = new Set()
  const server = net.createServer((s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => {})
    s.setEncoding('utf8')
    let buf = ''
    s.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.token !== token) { s.destroy(); return }
        const rec = { name: m.name, args: m.args, t0: Date.now() }
        calls.push(rec)
        onCall?.({ name: m.name, args: m.args })
        Promise.resolve()
          .then(() => { if (!callTool) throw new Error('这个宿主没有提供工具'); return callTool(m.name, m.args) })
          .then((v) => { rec.ms = Date.now() - rec.t0; rec.result = v; s.write(JSON.stringify({ id: m.id, text: stringify(v) }) + '\n') })
          .catch((e) => { rec.ms = Date.now() - rec.t0; rec.error = String(e?.message || e); s.write(JSON.stringify({ id: m.id, error: rec.error }) + '\n') })
      }
    })
  })
  await new Promise((res, rej) => { server.once('error', rej); server.listen(sockPath, res) })
  fs.chmodSync(sockPath, 0o600)
  const env = { AI_TOOLS_FILE: file, AI_TOOLS_SOCK: sockPath, AI_TOOLS_TOKEN: token }
  return {
    dir,
    defs,
    calls,
    env,
    command: node,
    args: [MCP_SCRIPT],
    // Claude：--mcp-config 的 JSON
    claudeConfig: () => JSON.stringify({ mcpServers: { [SERVER]: { type: 'stdio', command: node, args: [MCP_SCRIPT], env } } }),
    // Codex：-c mcp_servers.wt.*（值按 TOML 解析，JSON 字符串 / 数组正好是合法 TOML）
    codexArgs: () => [
      '-c', `mcp_servers.${SERVER}.command=${JSON.stringify(node)}`,
      '-c', `mcp_servers.${SERVER}.args=${JSON.stringify([MCP_SCRIPT])}`,
      '-c', `mcp_servers.${SERVER}.env={${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`,
    ],
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
