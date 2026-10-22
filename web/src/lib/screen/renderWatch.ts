// noVNC（1.7）按顺序画 JPEG：每张图用 data: URL 解码，只等 load 事件。某张图解码失败（触发的是 error）、
// 尺寸不对，或者一直解不出来时，渲染队列就卡在这张上；队列不空 noVNC 就不再处理收到的消息、也不再向 Mac 要新帧，
// 手机上的画面就定住了，而电脑、网络都正常（实测：电脑一直有新画面，手机近 1 分钟没要帧）。
// 这里补上：解码失败或卡住超过 STUCK_MS 的图直接跳过、马上要一次整屏，并把情况上报（kind=vnc-render）。
import RFB from '@novnc/novnc'
import { report } from '$lib/api'

const STUCK_MS = 3000
const SLOW_MS = 1500

export function watchRender(r: any): () => void {
  const d = r._display
  if (!d?._renderQ) return () => {}
  let drops = 0, slow = 0, maxMs = 0, lastSlowReport = 0
  const q = (): any[] => d._renderQ

  const origImageRect = d.imageRect.bind(d)
  d.imageRect = (x: number, y: number, w: number, h: number, mime: string, arr: Uint8Array) => {
    const n = q().length
    origImageRect(x, y, w, h, mime, arr)
    const a = q()[q().length - 1]
    if (q().length === n + 1 && a?.type === 'img') {
      a.t0 = performance.now(); a.bytes = arr.length
      a.img.addEventListener('error', () => { a.failed = true; d._scanRenderQ() }, { once: true })
      a.img.addEventListener('load', () => {
        const ms = performance.now() - a.t0
        maxMs = Math.max(maxMs, ms)
        if (ms > SLOW_MS) { slow++; if (Date.now() - lastSlowReport > 30000) { lastSlowReport = Date.now(); report('vnc-render', `slow decode ${Math.round(ms)}ms ${a.width}x${a.height} ${a.bytes}B queue ${q().length}`) } }
      }, { once: true })
    }
  }
  // 队首是坏图就跳过（原来的逻辑遇到它会直接 return，之后再也不往下画）
  const bad = (a: any) => a?.type === 'img' && (a.failed || (a.img.complete && (a.img.width !== a.width || a.img.height !== a.height)))
  const origScan = d._scanRenderQ.bind(d)
  d._scanRenderQ = () => {
    let skipped = 0
    while (bad(q()[0])) { const a = q().shift(); skipped++; report('vnc-render', `skip ${a.failed ? 'undecodable' : `wrong size ${a.img.width}x${a.img.height}`} image ${a.width}x${a.height} ${a.bytes}B`) }
    origScan()
    if (skipped) refresh()
  }
  // 跳过的图那块是旧画面：要一次整屏补上
  function refresh() {
    drops++
    try { if (d.width && r._sock) RFB.messages.fbUpdateRequest(r._sock, false, 0, 0, d.width, d.height) } catch {}
  }
  const timer = setInterval(() => {
    const a = q()[0]
    if (a?.type !== 'img' || a.img.complete || !a.t0) return
    const age = performance.now() - a.t0
    if (age < STUCK_MS) return
    report('vnc-render', `stuck ${Math.round(age)}ms on ${a.width}x${a.height} ${a.bytes}B image, queue ${q().length}, flushing ${!!r._flushing}; skipping`)
    a.failed = true
    d._scanRenderQ()
  }, 1000)
  return () => {
    clearInterval(timer)
    if (drops || slow) report('vnc-render', `session: skipped ${drops}, slow ${slow}, slowest ${Math.round(maxMs)}ms`)
  }
}
