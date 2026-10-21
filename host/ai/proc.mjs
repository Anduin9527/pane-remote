// agent 子进程：单独一个进程组（cursor-agent、codex 是脚本再起真正的进程），取消时按进程组号杀，
// 不按名字匹配。stdout 一行一个 JSON，逐行交给 onLine
import { spawn } from 'node:child_process'

export function startProc(cmd, args, { env, cwd, onLine, onExit, stdin = 'pipe' } = {}) {
  const p = spawn(cmd, args, { env, cwd, stdio: [stdin, 'pipe', 'pipe'], detached: true })
  const st = { proc: p, pid: p.pid, stderr: '', exited: false, code: null, signal: null, killed: false }
  let buf = ''
  p.stdout.setEncoding('utf8')
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) onLine?.(line)
    }
  })
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (d) => { st.stderr = (st.stderr + d).slice(-8000) })
  p.stdin?.on('error', () => {}) // 进程已退出时写 stdin 会 EPIPE
  p.on('error', (e) => { st.stderr += `\n${e.message}`; finish(null, null) })
  p.on('close', (code, signal) => {
    if (buf.trim()) onLine?.(buf.trim())
    buf = ''
    finish(code, signal)
  })
  function finish(code, signal) {
    if (st.exited) return
    st.exited = true
    st.code = code
    st.signal = signal
    onExit?.(st)
  }
  st.write = (obj) => { if (!st.exited) p.stdin.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n') }
  st.end = () => { try { p.stdin?.end() } catch {} }
  // 按进程组号杀（detached 时组号 = pid）；2 秒还没退就 SIGKILL
  st.kill = () => {
    if (st.exited || !st.pid) return
    st.killed = true
    const sig = (s) => { try { process.kill(-st.pid, s) } catch { try { process.kill(st.pid, s) } catch {} } }
    sig('SIGTERM')
    setTimeout(() => { if (!st.exited) sig('SIGKILL') }, 2000).unref()
  }
  return st
}

export const nowMs = () => Number(process.hrtime.bigint() / 1000000n)
