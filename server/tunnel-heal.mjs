// relay 模式的隧道自愈：中转服务器上的 relay.port（默认 127.0.0.1:2222）是电脑反向隧道的监听口。
// 隧道那条 TCP 在网络上悄悄断掉时（家里网络换出口、路由器丢了连接映射），电脑端的 ssh 会退出重连，
// 可服务器上旧的 sshd 会话还占着这个端口，新隧道每次都 bind 失败。旧会话自己不退：sshd 的 ClientAlive
// 要整整一个间隔没任何动静才探测，而中转一直在连这个端口把它唤醒；内核层面有没确认的数据要重传十几分钟才放弃。
// 这里每 15 秒连一次端口，看能不能收到电脑 sshd 的 "SSH-" 握手头；连续 45 秒收不到、并且端口被一个 sshd 会话占着，
// 就先记下那条连接的内核状态（ss -tnoi，事后判断是网络断了还是对端不读），再结束它，电脑端下一次重连就能接上。
// 端口没人监听 = 电脑睡着或离线，什么都不做。
// sshd 把会话子进程设成不可 dump，普通权限的 ss 看不出端口归哪个进程。先直接跑 ss（以 systemd 服务运行时给它
// CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH 就能看到；服务开着 NoNewPrivileges 时 sudo 根本跑不起来），看不到再试 sudo -n。
// 两样都没有就查不到占用者，没法自愈：这时记一次日志并回调 onStuck（不能悄悄失效）。结束会话本身不需要 sudo（和中转同一个用户时）。
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

function probe(port, timeout = 5000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok) }
    const s = net.connect(port, '127.0.0.1')
    s.setTimeout(timeout, () => finish(false))
    s.once('data', (d) => finish(String(d).startsWith('SSH-')))
    s.once('error', () => finish(false))
    s.once('close', () => finish(false))
  })
}

const exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? '' : out)))
// 先直接跑；看不到进程信息（没有 users:）再试 sudo
async function ss(args) {
  const out = await exec('ss', args)
  return out.includes('users:') ? out : (await exec('sudo', ['-n', 'ss', ...args])) || out
}

// 占着 127.0.0.1:<port> 的 sshd 会话的 pid（只认 sshd，别的进程不碰）
async function holder(port) {
  const out = await ss(['-Hltnp', `sport = :${port}`])
  for (const line of out.split('\n')) {
    if (!line.includes(`127.0.0.1:${port}`)) continue
    const m = /"sshd(?:-session)?",pid=(\d+)/.exec(line)
    if (m) return Number(m[1])
  }
  return null
}

async function evidence(pid) {
  const lines = (await ss(['-tnoip', 'state', 'established'])).split('\n')
  const i = lines.findIndex((l) => l.includes(`pid=${pid},`) && !/127\.0\.0\.1:\d+\s+127\.0\.0\.1/.test(l))
  // -i 的详细信息在下一行
  return i < 0 ? '(没找到对应的连接)' : [lines[i], lines[i + 1] || ''].map((l) => l.trim()).join('\n')
}

export function startTunnelHeal({ port, dataDir, interval = 15000, after = 45000, cooldown = 120000, onStuck }) {
  let badSince = 0
  let lastKill = 0
  let busy = false
  let warned = false
  const logFile = dataDir && path.join(dataDir, 'tunnel-heal.log')
  async function tick() {
    if (busy) return
    busy = true
    try {
      if (await probe(port)) { badSince = 0; warned = false; return }
      const t = Date.now()
      if (!badSince) badSince = t
      if (t - badSince < after || t - lastKill < cooldown) return
      const pid = await holder(port)
      if (!pid) {
        // 有人监听却查不到是谁：权限不够，自愈做不了事，必须让人知道
        if ((await exec('ss', ['-Hltn', `sport = :${port}`])).includes(`127.0.0.1:${port}`) && !warned) {
          warned = true
          const msg = `${port} 卡住了，但查不到占着它的进程（权限不够），没法自动恢复`
          console.log(`tunnel-heal: ${msg}`)
          onStuck?.(msg)
        }
        return // 没人监听：电脑睡着 / 离线，等它自己连上来
      }
      const ev = await evidence(pid)
      try { process.kill(pid, 'SIGTERM') } catch (e) { console.log(`tunnel-heal: kill ${pid}: ${e.message}`); return }
      const secs = Math.round((t - badSince) / 1000)
      lastKill = t
      badSince = 0
      console.log(`tunnel-heal: ${port} ${secs}s 无响应，结束卡住的 sshd 会话 ${pid}\n${ev}`)
      if (logFile) fs.appendFile(logFile, `${new Date(t).toISOString()} killed sshd ${pid}\n${ev}\n\n`, () => {})
    } finally {
      busy = false
    }
  }
  return setInterval(() => tick().catch((e) => console.log(`tunnel-heal: ${e.message}`)), interval)
}
