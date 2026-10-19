// 看屏幕模块（可选，macOS，pane-remote enable screen）的服务端：手机上看 / 操作电脑屏幕，画面来自系统自带的屏幕共享。
//   GET  /api/screen/displays   每块显示器（只给手机显示选屏按钮用；位置换算在电脑上的转码代理里）
//   GET  /api/screen/windows    能单独看的窗口（含别的桌面上的），来自 mousectl
//   GET  /api/screen/apps       装了的 app，标出在运行的
//   POST /api/screen/launch {bundle}  后台打开一个 app，不抢前台
//   POST /api/screen/summon {bundle}  唤出一个 app 的窗口（只有菜单栏图标的 app：按它的唤出快捷键或点菜单栏图标）
//   WS   /api/screen/vnc?view=屏序号,清晰   手机上的 noVNC ⇄ bridge 的 screen（电脑上的转码代理 agent/screen/proxy.mjs）⇄ 屏幕共享
// 画面在电脑上裁剪、缩放、压成 JPEG 再过来，这里只把 bridge 进程的 stdin/stdout 跟 WebSocket 对接；
// 登录用的是屏幕共享自己的认证（ARD，凭据在手机上加密），服务端看不到密码。
import { WebSocketServer } from 'ws'

const err = (msg, code) => Object.assign(new Error(msg), { code })

export function createScreen({ bridge, bridgeProc }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 })

  /** 处理 /api/screen/<动作>；返回要回给手机的 JSON，出错抛带 code 的 Error */
  async function http(method, action, body) {
    if (method === 'GET' && action === 'displays') return { displays: JSON.parse(await bridge('screen-displays')) }
    if (method === 'GET' && (action === 'windows' || action === 'apps')) {
      const r = JSON.parse(await bridge(`screen-${action}`).catch((e) => JSON.stringify({ error: e.message })))
      if (r.error) throw err(r.error, 503)
      return r
    }
    if (method === 'POST' && (action === 'launch' || action === 'summon')) {
      const id = String(body?.bundle ?? '')
      if (!/^[A-Za-z0-9.-]{1,200}$/.test(id)) throw err('bad bundle id', 400)
      const r = (await bridge(`screen-${action} ${id}`)).trim()
      if (r !== 'ok') throw err(r.replace(/^error: /, '') || 'failed', 502)
      return { ok: true }
    }
    throw err('not found', 404)
  }

  /** WebSocket 升级（身份、来源、模块开关已经在 server.mjs 里查过） */
  function upgrade(req, socket, head, url) {
    const view = String(url.searchParams.get('view') || '0,0')
    if (!/^[0-9]{1,2},[01]$/.test(view)) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, (ws) => pipe(ws, view))
  }

  function pipe(ws, view) {
    const proc = bridgeProc(`screen ${view}`, ['pipe', 'pipe', 'pipe'])
    // 每个连接记流量：每 5 秒一行（有新数据时），断开时一行
    const id = Math.random().toString(36).slice(2, 6), t0 = Date.now()
    let bIn = 0, bOut = 0, lastIn = 0, errText = ''
    const stat = setInterval(() => { if (bIn !== lastIn) console.log(`screen ${id} +${Math.round((Date.now() - t0) / 1000)}s computer→phone ${bIn}B phone→computer ${bOut}B buffered ${ws.bufferedAmount}`); lastIn = bIn }, 5000)
    let done = false
    const end = () => {
      if (done) return
      done = true
      clearInterval(stat); clearInterval(watch)
      try { proc.kill() } catch {}
      console.log(`screen ${id} closed after ${Math.round((Date.now() - t0) / 1000)}s, computer→phone ${bIn}B phone→computer ${bOut}B`)
      // 一个字节都没收到就断了：多半是屏幕共享没开（转码代理连 5900 被拒）或电脑那头起不来，带上原因
      if (ws.readyState <= 1) ws.close(bIn ? 1000 : 4001, bIn ? '' : (errText.includes('ECONNREFUSED') ? '电脑的屏幕共享没开' : '连不上电脑的屏幕共享'))
    }
    proc.stdout.on('data', (d) => {
      bIn += d.length
      ws.send(d)
      // 积压太多先停读（转码代理按手机的请求发，正常不会堆）
      if (ws.bufferedAmount > 4 << 20) {
        proc.stdout.pause()
        const t = setInterval(() => {
          if (ws.readyState !== 1) { clearInterval(t); return }
          if (ws.bufferedAmount < 1 << 20) { clearInterval(t); proc.stdout.resume() }
        }, 50)
      }
    })
    proc.stderr.on('data', (d) => {
      errText = (errText + d).slice(-4000)
      for (const l of String(d).split('\n')) if (l.trim()) console.log(`screen ${id} ${l.trim().slice(0, 200)}`)
    })
    proc.on('exit', end)
    proc.on('error', end)
    proc.stdin.on('error', () => {})
    // 手机说断开时立刻掐断：ws 要等积压的画面数据发完才走完关闭握手，这期间电脑上一直显示有人在看
    const watch = setInterval(() => { if (ws.readyState >= 2) { end(); ws.terminate() } }, 200)
    ws.on('message', (d) => { bOut += d.length; proc.stdin.write(d) })
    ws.on('close', end)
    ws.on('error', end)
  }

  return { http, upgrade }
}
