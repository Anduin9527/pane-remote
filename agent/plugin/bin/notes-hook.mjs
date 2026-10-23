#!/usr/bin/env node
// Claude Code 的 UserPromptSubmit hook：用户每发一条消息，先去 pane-host 取插件给这个会话的留言（platform.sessions.note，
// 比如用户在手机上把这个会话建的待办勾掉了），有就打印出来，Claude Code 把它作为这一轮的附加上下文。
// 取不到（pane-host / 服务端不在线）就什么都不输出，绝不挡住用户的消息。
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const SOCK = process.env.PANE_HOST_SOCK || path.join(os.homedir(), '.cache/pane-remote-host/host.sock')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  let session = ''
  try { session = String(JSON.parse(input).session_id || '') } catch {} // ignore: 不是 JSON 就当没有会话 id
  if (!/^[\w-]{8,80}$/.test(session)) return process.exit(0)
  const c = net.connect(SOCK)
  const bye = () => { c.destroy(); process.exit(0) }
  const timer = setTimeout(bye, 2000)
  let buf = ''
  c.on('connect', () => c.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions.notes.take', params: { session } }) + '\n'))
  c.on('data', (d) => {
    buf += d
    if (!buf.includes('\n')) return
    clearTimeout(timer)
    try {
      const notes = JSON.parse(buf.slice(0, buf.indexOf('\n'))).result?.notes || []
      if (notes.length) process.stdout.write(`[pane-remote] Updates for this session since your last turn (made by the user on their phone):\n${notes.map((n) => `- ${n.name || n.plugin}: ${n.text}`).join('\n')}\n`)
    } catch {} // ignore: 回复坏了就不输出
    bye()
  })
  c.on('error', bye)
})
