#!/usr/bin/env node
// 连接器：bridge 的 `host` 指令 exec 它。stdin/stdout ⇄ pane-host 的 unix socket，原样转发（按行 JSON，不解析）。
// pane-host 不在（launchd 没装 / 刚崩）就就地拉起一个（detached，日志写 host.log，10 分钟没人连自己退出），再连。
// 任何一边断了就退出：ssh 断开 → stdin 结束 → 退出；pane-host 重启 → socket 断 → 退出，服务端那边会重连
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { RUN_DIR, SOCK, LOG, HOST_ROOT } from './paths.mjs'

const die = (msg) => { process.stderr.write(`error: ${msg}\n`); process.exit(2) }
const connect = () => new Promise((resolve, reject) => {
  const s = net.connect(SOCK)
  s.once('connect', () => resolve(s))
  s.once('error', reject)
})

let sock
try { sock = await connect() } catch {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 })
  const out = fs.openSync(LOG, 'a', 0o600)
  spawn(process.execPath, [path.join(HOST_ROOT, 'main.mjs')], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, PANE_HOST_AUTOSTARTED: '1' } }).unref()
  for (let i = 0; i < 50 && !sock; i++) {
    await new Promise((r) => setTimeout(r, 100))
    sock = await connect().catch(() => null) // ignore: 还没起来，接着等
  }
  if (!sock) die('pane-host 起不来，见 ' + LOG)
}
process.stdin.pipe(sock)
sock.pipe(process.stdout)
process.stdin.on('end', () => sock.end())
process.stdin.on('error', () => process.exit(0))
process.stdout.on('error', () => process.exit(0))
sock.on('close', () => process.exit(0))
sock.on('error', () => process.exit(1))
