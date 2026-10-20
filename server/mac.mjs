// mac 模块（可选，macOS，pane-remote enable mac）的服务端：这台电脑的性能快照、让它用自带的 say 念一段话。
//   GET  /api/mac/perf      CPU（用户 / 系统）、负载、内存（含压力、压缩、交换区）、占 CPU / 内存最多的 5 个进程（采样要 2 秒左右）
//   GET  /api/mac/voices    say 能用的嗓音（中文排前面）
//   POST /api/mac/say {text, voice, rate, volume}  后台开始念、马上返回；volume = 念的时候临时用的音量 0–100（念完调回去），不给就不动
//   POST /api/mac/say-stop  停掉正在念的
// 参数在这里先查一遍，再 base64 编码交给 bridge；电脑上的脚本把文字、嗓音作为参数直接交给 say（不经过 shell）
const err = (msg, code) => Object.assign(new Error(msg), { code })
const clean = (e) => String(e?.message || e).replace(/^error: /, '') || 'failed'

export function createMac({ bridge }) {
  async function call(cmd, code = 502) {
    try { return (await bridge(cmd)).trim() } catch (e) { throw err(clean(e), code) }
  }
  /** 处理 /api/mac/<动作>；返回要回给手机的 JSON，出错抛带 code 的 Error */
  async function http(method, action, body) {
    if (method === 'GET' && action === 'perf') return JSON.parse(await call('mac-perf', 503))
    if (method === 'GET' && action === 'voices') return { voices: JSON.parse(await call('mac-voices', 503)) }
    if (method === 'POST' && action === 'say') {
      const text = String(body?.text ?? '').trim()
      if (!text || text.length > 2000) throw err('bad text', 400)
      const voice = String(body?.voice ?? '')
      if (voice.length > 100) throw err('bad voice', 400)
      const vol = body?.volume == null || body.volume === '' ? null : Number(body.volume)
      const req = { text, voice, rate: Math.max(80, Math.min(400, Math.round(Number(body?.rate) || 180))), volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : null }
      const b64 = Buffer.from(JSON.stringify(req), 'utf8').toString('base64')
      if (b64.length > 12000) throw err('bad text', 400) // bridge 那边的上限
      const r = await call(`mac-say ${b64}`)
      if (!r.startsWith('ok')) throw err(clean(r), 502)
      return { ok: true }
    }
    if (method === 'POST' && action === 'say-stop') { await call('mac-say-stop'); return { ok: true } }
    throw err('not found', 404)
  }
  return { http }
}
