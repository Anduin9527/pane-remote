// 电脑性能快照（mac 模块，bridge 的 mac-perf）：CPU、内存、交换区，占 CPU / 内存最多的几个进程。只读系统自带命令，输出一行 JSON
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }) } catch { return '' } }
// 「32G」「6056M」「165M+」→ 字节
const bytes = (s) => {
  const m = /([\d.]+)([BKMGT])/.exec(s || '')
  return m ? Math.round(Number(m[1]) * 1024 ** 'BKMGT'.indexOf(m[2])) : 0
}
/** top 的进程表：PID、名字（被截到 16 字）、%CPU、内存 */
function procs(out) {
  const lines = out.split('\n')
  const i = lines.findLastIndex((l) => /^PID\s+COMMAND/.test(l))
  if (i < 0) return []
  return lines.slice(i + 1).map((l) => /^(\d+)\s+(.*?)\s+([\d.]+)\s+(\S+)\s*$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), cpu: Number(m[3]), mem: bytes(m[4]) }))
}
// CPU 要两次采样才准（第一次是开机以来的平均），取第二次
const cpuOut = run('/usr/bin/top', ['-l', '2', '-s', '1', '-n', '6', '-o', 'cpu', '-stats', 'pid,command,cpu,mem'])
const memOut = run('/usr/bin/top', ['-l', '1', '-n', '6', '-o', 'mem', '-stats', 'pid,command,cpu,mem'])
const second = cpuOut.slice(cpuOut.lastIndexOf('Processes:'))
const cu = /CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/.exec(second) || []
const pm = /PhysMem: (\S+) used \((\S+) wired(?:, (\S+) compressor)?\), (\S+) unused/.exec(second) || []
const la = /Load Avg: ([\d.]+), ([\d.]+), ([\d.]+)/.exec(second) || []
const total = Number(run('/usr/sbin/sysctl', ['-n', 'hw.memsize']).trim()) || 0
const swap = /total = ([\d.]+M)\s+used = ([\d.]+M)/.exec(run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])) || []
const freePct = Number((/free percentage: (\d+)%/.exec(run('/usr/bin/memory_pressure', ['-Q'])) || [])[1])

const topCpu = procs(second).slice(0, 5), topMem = procs(memOut).slice(0, 5)
// 完整名字：top 只给 16 个字；用 ps 拿可执行文件路径，显示文件名，属于某个 .app 的标上 app 名
const pids = [...new Set([...topCpu, ...topMem].map((p) => p.pid))]
const names = {}
for (const l of run('/bin/ps', ['-o', 'pid=,comm=', '-p', pids.join(',') || '1']).split('\n')) {
  const m = /^\s*(\d+)\s+(.*)$/.exec(l)
  if (!m) continue
  const p = m[2], app = /\/([^/]+)\.app\//.exec(p)
  names[m[1]] = { name: path.basename(p), app: app ? app[1] : '' }
}
const named = (p) => ({ ...p, name: names[p.pid]?.name || (p.pid === 0 ? 'kernel_task' : String(p.pid)), app: names[p.pid]?.app || '' })

console.log(JSON.stringify({
  cores: Number(run('/usr/sbin/sysctl', ['-n', 'hw.ncpu']).trim()) || 0,
  cpu: { user: Number(cu[1]) || 0, sys: Number(cu[2]) || 0, idle: Number(cu[3]) || 0 },
  load: la.slice(1).map(Number),
  mem: { total, used: bytes(pm[1]), wired: bytes(pm[2]), compressed: bytes(pm[3]), unused: bytes(pm[4]), freePct: Number.isFinite(freePct) ? freePct : null },
  swap: { total: bytes(swap[1]), used: bytes(swap[2]) },
  topCpu: topCpu.map(named),
  topMem: topMem.map(named),
}))
