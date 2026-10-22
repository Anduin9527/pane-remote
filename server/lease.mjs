// 单客户端在线 + 挡住被遥控电脑自己访问。
//
// 顶号：同一时间只有一个客户端（浏览器标签页 / PWA）在用。每个客户端有自己的编号（前端放在 sessionStorage，
// 刷新不变，关掉就没了），打开时 claim，顶掉别人。被顶的客户端：
//   - 正开着的 SSE 收到一条 kicked 事件后断开；WebSocket 直接断开，重连时被拒（关闭码 4001，原因里是谁顶的）
//   - 之后带着编号的接口请求一律 409 {error:'kicked'}
// 前端收到任一信号就停掉所有连接，显示「已在 X 上打开」和「在这台设备上继续」（点了就重载并重新 claim，可以来回顶）。
// 当前在用的是谁存在数据目录（lease.json），中转重启后不变，被顶的客户端重连也进不来。
// 不带编号的请求（<img> 之类、旧版前端）不拦：顶号是为了别同时操作，不是权限控制，权限还是靠登录身份。
//
// 本机访问：被遥控的电脑上打开遥控页面没有意义（还会和真正的设备互相顶）。pane-host 定时上报本机所有网卡地址，
// 访问者的来源 IP 在里面就是本机。来源 IP：直连时是 TCP 对端；对端是本机回环（前面有 tailscale serve / nginx
// 之类的本机反向代理）时取 X-Forwarded-For 的最后一个（代理自己追加的，客户端伪造不了）。
// 中转和被遥控的电脑是同一台时，回环来的请求（没有代理头）也算本机（loopbackIsHost: false 关掉这一条，只认代理头）。
// ALLOW_HOST_ACCESS=1 关掉整个检查。
import fs from 'node:fs'
import os from 'node:os'

const norm = (ip) => String(ip || '').trim().replace(/^::ffff:/, '').replace(/%.*$/, '').toLowerCase()
const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.')

export function clientIp(req) {
  const peer = norm(req.socket?.remoteAddress)
  const xff = req.headers['x-forwarded-for']
  if (isLoopback(peer) && xff) return norm(String(xff).split(',').pop())
  return peer
}

export function createHostCheck({ allow = false, loopbackIsHost = true, selfAddrs = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a.address) } = {}) {
  let hostAddrs = new Set()
  let colocated = false
  return {
    // pane-host ping 的返回值：{ addrs, hostnames }
    update(r) {
      if (!Array.isArray(r?.addrs)) return
      const next = new Set(r.addrs.map(norm).filter((a) => a && !isLoopback(a) && !a.startsWith('fe80:')))
      const changed = next.size !== hostAddrs.size || [...next].some((a) => !hostAddrs.has(a))
      hostAddrs = next
      colocated = selfAddrs().map(norm).some((a) => hostAddrs.has(a))
      return changed
    },
    addrs: () => [...hostAddrs],
    isHost(req) {
      if (allow || !hostAddrs.size) return false
      const ip = clientIp(req)
      if (hostAddrs.has(ip)) return true
      return loopbackIsHost && colocated && isLoopback(ip) && !req.headers['x-forwarded-for']
    },
  }
}

// 设备名：有 tailscale 设备信息就用它，没有就从 UA 猜
export function deviceName(req, node) {
  if (node?.name) return node.name
  const ua = String(req.headers['user-agent'] || '')
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '另一台设备'
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return br && !/iPhone|iPad/.test(dev) ? `${dev} ${br}` : dev
}

export const validClient = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)

export function createLease({ file, log = console.log } = {}) {
  let cur = null // { client, device, since }
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {} // ignore: 第一次运行没有文件
  const conns = new Map() // client → Set<{ kick(info) }>
  // 同步写：异步写连着顶两次时完成顺序可能颠倒，落盘的不是最新的。文件很小、顶号也不频繁
  const save = () => { if (file) try { fs.writeFileSync(file, JSON.stringify(cur)) } catch (e) { log(`lease: save failed: ${e.message}`) } }
  const info = () => ({ device: cur?.device || '', since: cur?.since || 0 })
  return {
    current: () => cur && { ...cur },
    info,
    // 没人用过（或被清掉）时，第一个来的就是在用的
    isHolder(client) { return !cur || cur.client === client },
    claim(client, device) {
      const prev = cur
      cur = { client, device, since: Date.now() }
      save()
      if (prev && prev.client !== client) log(`lease: ${device} 顶掉了 ${prev.device}`)
      for (const [c, set] of conns) {
        if (c === client) continue
        for (const k of set) { try { k.kick(info()) } catch {} } // ignore: 连接已经断了
        conns.delete(c)
      }
      return info()
    },
    // 登记一条长连接（SSE / WebSocket），被顶时调用 kick；返回取消登记的函数
    track(client, kick) {
      let set = conns.get(client)
      if (!set) conns.set(client, (set = new Set()))
      const k = { kick }
      set.add(k)
      return () => { set.delete(k); if (!set.size && conns.get(client) === set) conns.delete(client) }
    },
  }
}
