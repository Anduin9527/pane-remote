// 手机看 Mac 屏幕的转码代理（screen 模块）：跑在电脑上，由 bridge 的 `screen <参数>` 拉起，stdin/stdout 就是手机那头的 RFB 流，
// 经服务端（relay 模式再经中转服务器）→ WebSocket 到手机上的 noVNC；另一头连本机的屏幕共享 127.0.0.1:5900。
//
// 为什么要它：苹果的屏幕共享只给 ZRLE（对照片 / 壁纸几乎压不动，一块 4K 屏第一帧就十几 MB，中转服务器带宽小时要等半分钟），
// 而且多屏会拼成一整张大画面（超过手机浏览器画布的上限会黑屏）。这里在电脑上把画面解开、只留选中的那块屏、
// 默认缩到「点」的分辨率（像素少 4 倍），再按 Tight 编码的 JPEG 发给手机（noVNC 认），第一帧几百 KB。
//
// 握手和认证照原样转（ARD 30 号认证，凭据是手机加密的，这里看不到密码），只做两处修补：
//   - 苹果报 RFB 003.889，noVNC 回 003.008，苹果不接受，把回的版本号改成 003.889
//   - 认证失败苹果只回 4 字节的 1，不带原因，noVNC 会一直等：补一段原因
// ServerInit 之后两头各说各的：
//   Mac 这头：固定 32 位 RGB、只要 ZRLE / Raw，解到裁好的画面缓冲里，记下变了的区域，一帧收完马上再要下一帧（增量）
//   手机这头：手机要一帧（FramebufferUpdateRequest）才发一帧，只发变了的区域；手机网慢就自然跳帧，不在路上堆积
//   鼠标坐标按缩放和裁剪换回整张画面的坐标；键盘、剪贴板原样转
//   自定义消息 250：换屏 / 换清晰度（不用重新认证）；252：只看某个窗口（画面来自 mousectl）；253：把之前的前台 app 切回来
//   换屏或刚连上时，整块画面收齐了才发给手机，并在这一帧末尾带一个 DesktopName，手机据此知道「画面到了」
//
// 每块屏在整张画面里的位置不能按系统的屏幕坐标直接换算（多屏、有负坐标的排布下，整张宽度会比按 2 倍算的少一截，
// 苹果把有的屏左右挪了一截）。纵向是按倍数排开的，可以直接算；横向要量：通过屏幕共享把鼠标挪到每块屏所在的那一行，
// 读系统报的光标横坐标反推偏移（只用坐标，不看画面），结果按显示器布局缓存，布局不变下次直接用。
//
// 鼠标不走屏幕共享：多屏时苹果只能把光标的纵坐标放在其中一排屏里，别的屏点不到。改由常驻的 mousectl
// （mousectl.swift，install-mousectl.sh 装成 LaunchAgent，需要「辅助功能」授权）直接发系统鼠标事件；它不在时才退回屏幕共享。
//
// 参数：显示器序号（跟 bridge displays 的顺序一样，0 是主屏）,清晰模式 0/1
import net from 'node:net'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import sharp from 'sharp'

sharp.concurrency(4)
const log = (...a) => process.stderr.write(`vnc-proxy ${a.join(' ')}\n`)
const parseArg = (s) => {
  const m = /^(\d{1,2}),([01])$/.exec(String(s || ''))
  return m ? { index: Number(m[1]), hi: m[2] === '1' } : null
}
let view = parseArg(process.argv[2])
if (!view) { log('bad args'); process.exit(2) }

// ---------- 按字节读：攒够 n 字节再给 ----------
class Reader {
  chunks = []; len = 0; wait = null; ended = false
  push(b) { this.chunks.push(b); this.len += b.length; this.wake() }
  end() { this.ended = true; this.wake() }
  wake() { const w = this.wait; if (w && (this.len >= w.n || this.ended)) { this.wait = null; w.res() } }
  async need(n) {
    while (this.len < n) {
      if (this.ended) throw new Error('eof')
      await new Promise((res) => { this.wait = { n, res } })
    }
    let out
    if (this.chunks[0].length >= n) out = this.chunks[0].subarray(0, n)
    else out = Buffer.concat(this.chunks, Math.max(n, 0)).subarray(0, n)
    // 从队首去掉 n 字节
    let left = n
    while (left > 0) {
      const c = this.chunks[0]
      if (c.length <= left) { this.chunks.shift(); left -= c.length }
      else { this.chunks[0] = c.subarray(left); left = 0 }
    }
    this.len -= n
    return out
  }
}

const MAC_PORT = Number(process.env.VNC_PROXY_PORT || 5900) // 测试时指到假服务器
const mac = net.connect(MAC_PORT, '127.0.0.1')
mac.setNoDelay(true)
const fromMac = new Reader(), fromPhone = new Reader()
mac.on('data', (b) => fromMac.push(b))
mac.on('error', (e) => { log('mac error', e.code || e.message); process.exit(1) })
mac.on('close', () => { log('mac closed'); process.exit(0) })
process.stdin.on('data', (b) => fromPhone.push(b))
process.stdin.on('end', () => { mac.destroy(); process.exit(0) })
process.stdout.on('error', () => { mac.destroy(); process.exit(0) })
const toPhone = (b) => process.stdout.write(b)
const toMac = (b) => mac.write(b)
const u16 = (b, o = 0) => b.readUInt16BE(o)
const u32 = (b, o = 0) => b.readUInt32BE(o)

// ---------- 握手、认证：原样转 ----------
async function handshake() {
  const ver = await fromMac.need(12)
  toPhone(ver)
  const apple = ver.toString('latin1') === 'RFB 003.889\n'
  let pv = await fromPhone.need(12)
  if (apple && pv.toString('latin1') === 'RFB 003.008\n') pv = Buffer.from('RFB 003.889\n', 'latin1')
  toMac(pv)
  const n = (await fromMac.need(1))[0]
  if (n === 0) { const l = await fromMac.need(4); toPhone(Buffer.concat([Buffer.from([0]), l, await fromMac.need(u32(l))])); throw new Error('server refused') }
  toPhone(Buffer.concat([Buffer.from([n]), await fromMac.need(n)]))
  const choice = await fromPhone.need(1)
  toMac(choice)
  if (choice[0] === 30) {
    const hdr = await fromMac.need(4)
    const keyLen = u16(hdr, 2)
    toPhone(Buffer.concat([hdr, await fromMac.need(2 * keyLen)]))
    toMac(await fromPhone.need(128 + keyLen))
  } else if (choice[0] !== 1) throw new Error('unsupported security type ' + choice[0])
  const res = await fromMac.need(4)
  if (u32(res) !== 0) {
    const why = Buffer.from('Authentication failed')
    const len = Buffer.alloc(4); len.writeUInt32BE(why.length)
    toPhone(Buffer.concat([res, len, why]))
    throw new Error('auth failed')
  }
  toPhone(res)
  await fromPhone.need(1) // ClientInit：一律共享，别把别人踢掉
  toMac(Buffer.from([1]))
  const si = await fromMac.need(24)
  const name = await fromMac.need(u32(si, 20))
  return { W: u16(si, 0), H: u16(si, 2), pf: si.subarray(4, 20), name: name.toString('utf8') }
}

// ---------- 裁剪 / 缩放 ----------
let W = 0, H = 0, name = ''
let crop = { x: 0, y: 0, w: 0, h: 0 }, s = 1 // s：缩小倍数（整张画面几个像素合成手机上一个像素）
let fb = Buffer.alloc(0) // 裁好的那块，RGB 每像素 3 字节，未缩放
let dirty = [] // 变了的区域（裁剪内坐标，未缩放）
let fresh = false, covered = 0, freshTimer = null // 换屏后整块收齐了没有
// 收齐没有按 8 像素一格记（同一块区域重复发不能算两遍）
const TILE = 8
let tiles = null, tilesLeft = 0
const stats = { rects: 0, bytes: 0, enc: {} }
let sendSize = false, announce = false

// ---------- 显示器和校准 ----------
// 每块屏：全局坐标（点，左上角原点，跟 CGDisplayBounds 一样）、像素大小、在整张画面里的矩形（校准后才有）
let screens = [] // { name, x, y, w, h, pw, ph, fb: {x,y,w,h} | null }
function readScreens() {
  const js = 'ObjC.import("AppKit"); ObjC.import("CoreGraphics"); JSON.stringify(ObjC.unwrap($.NSScreen.screens).map(s => { const id = ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")); const b = $.CGDisplayBounds(id); const m = $.CGDisplayCopyDisplayMode(id); return { name: ObjC.unwrap(s.localizedName), x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height, pw: Number($.CGDisplayModeGetPixelWidth(m)), ph: Number($.CGDisplayModeGetPixelHeight(m)) } }))'
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 10000 }))
}
const CACHE = process.env.VNC_PROXY_CACHE || path.join(process.env.HOME, '.cache/pane-remote/screen-layout.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function pointer(x, y) {
  const b = Buffer.from([5, 0, 0, 0, 0, 0]); b.writeUInt16BE(Math.max(0, Math.min(W - 1, Math.round(x))), 2); b.writeUInt16BE(Math.max(0, Math.min(H - 1, Math.round(y))), 4)
  toMac(b)
}
// 鼠标助手（mousectl.swift，LaunchAgent 常驻在登录会话里）：有它就由它直接发系统鼠标事件，坐标按选中的屏换成全局点；
// 没有就退回走屏幕共享（多屏时苹果只能把光标放进其中一排屏，别的屏点不到）
const MOUSE_SOCK = process.env.VNC_PROXY_MOUSECTL || path.join(process.env.HOME, '.cache/pane-remote/mouse.sock')
let mousectl = null
{
  const c = net.connect(MOUSE_SOCK)
  c.on('connect', () => { mousectl = c; log('mousectl connected') })
  c.on('error', (e) => { mousectl = null; log('mousectl unavailable, pointer via screen sharing:', e.code) })
  c.on('close', () => { mousectl = null })
}
let viewRect = null, viewDisp = null
// 键盘也交给 mousectl（跟文字、点击排同一个队列，先后不乱）：VNC keysym → macOS 虚拟键码（美式键位）
const MOD_FLAGS = { 0xffe1: 0x20000, 0xffe2: 0x20000, 0xffe3: 0x40000, 0xffe4: 0x40000, 0xffe9: 0x80000, 0xffea: 0x80000, 0xffe7: 0x100000, 0xffe8: 0x100000, 0xffeb: 0x100000, 0xffec: 0x100000 }
const MOD_CODES = { 0xffe1: 56, 0xffe2: 60, 0xffe3: 59, 0xffe4: 62, 0xffe9: 58, 0xffea: 61, 0xffe7: 55, 0xffe8: 54, 0xffeb: 55, 0xffec: 54 }
const SPECIAL = { 0xff0d: 36, 0xff8d: 76, 0xff09: 48, 0x20: 49, 0xff08: 51, 0xff1b: 53, 0xffff: 117, 0xff51: 123, 0xff53: 124, 0xff54: 125, 0xff52: 126, 0xff50: 115, 0xff57: 119, 0xff55: 116, 0xff56: 121,
  0xffbe: 122, 0xffbf: 120, 0xffc0: 99, 0xffc1: 118, 0xffc2: 96, 0xffc3: 97, 0xffc4: 98, 0xffc5: 100, 0xffc6: 101, 0xffc7: 109, 0xffc8: 103, 0xffc9: 111 }
const ANSI = Object.fromEntries([...'asdfhgzxcv'].map((c, i) => [c, i]).concat([['b', 11], ['q', 12], ['w', 13], ['e', 14], ['r', 15], ['y', 16], ['t', 17], ['1', 18], ['2', 19], ['3', 20], ['4', 21], ['6', 22], ['5', 23], ['=', 24], ['9', 25], ['7', 26], ['-', 27], ['8', 28], ['0', 29], [']', 30], ['o', 31], ['u', 32], ['[', 33], ['i', 34], ['p', 35], ['l', 37], ['j', 38], ["'", 39], ['k', 40], [';', 41], ['\\', 42], [',', 43], ['/', 44], ['n', 45], ['m', 46], ['.', 47], ['`', 50]]))
const SHIFTED = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' }
const held = new Set() // 按住的修饰键 keysym
/** 处理了返回 true；处理不了（比如非美式键位的字符带修饰键）返回 false 交给屏幕共享 */
function keyToMousectl(down, sym) {
  const flags = () => [...held].reduce((f, k) => f | MOD_FLAGS[k], 0)
  if (sym in MOD_FLAGS) {
    if (down) held.add(sym); else held.delete(sym)
    mousectl.write(keyCmd(MOD_CODES[sym], flags(), down))
    return true
  }
  if (sym in SPECIAL) {
    // 真键盘的方向键带 Fn + 小键盘标志、F 键和 Home/End 这些带 Fn；系统快捷键（⌃← 切桌面、F11 显示桌面）要标志对上才认
    const code = SPECIAL[sym], extra = code >= 123 && code <= 126 ? 0xa00000 : sym >= 0xff50 && sym !== 0xff8d ? 0x800000 : 0
    mousectl.write(keyCmd(code, flags() | extra, down))
    return true
  }
  const ch = sym < 0x100 ? String.fromCharCode(sym) : sym >= 0x01000000 ? String.fromCodePoint(sym & 0xffffff) : null
  if (ch == null) return false
  const onlyShift = [...held].every((k) => MOD_FLAGS[k] === 0x20000)
  // 普通字符（没按修饰键或只按了 Shift）：当文字粘贴，按下时发一次，松开忽略
  if (onlyShift) { if (down) mousectl.write(textCmd(ch)); return true }
  // ⌘C 这类组合键：按美式键位找键码
  const base = SHIFTED[ch] ?? ch.toLowerCase()
  if (!(base in ANSI)) return false
  const f = flags() | (SHIFTED[ch] || ch !== ch.toLowerCase() ? 0x20000 : 0)
  mousectl.write(keyCmd(ANSI[base], f, down))
  return true
}
let sig = ''
/** 读显示器，有缓存的校准结果就用上；返回是否用上了缓存 */
function loadScreens() {
  try { screens = process.env.VNC_PROXY_SCREENS ? JSON.parse(process.env.VNC_PROXY_SCREENS) : readScreens() } catch (e) { log('读不到显示器', e.message); screens = []; return true }
  sig = JSON.stringify({ W, H, s: screens.map((d) => [d.x, d.y, d.w, d.h, d.pw, d.ph]) })
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
    if (c.sig === sig) { c.fb.forEach((r, i) => { screens[i].fb = r }); log('layout from cache', JSON.stringify(c.fb)); return true }
  } catch {}
  return screens.length < 2
}
/** 校准：画面已经在传了再做（连接没初始化完就动鼠标，苹果之后不再发画面）。成功返回 true */
async function calibrate() {
  // 光标位置：一个常驻的 osascript，stdin 来一行回一行（全局点坐标，左下角原点 → 换成左上角）
  const mainH = screens[0].h
  // 测试时可以换成假的（VNC_PROXY_MOUSE：一个 node 脚本，同样一问一答）
  const helper = process.env.VNC_PROXY_MOUSE
    ? spawn(process.execPath, [process.env.VNC_PROXY_MOUSE], { stdio: ['pipe', 'pipe', 'ignore'] })
    : spawn('osascript', ['-l', 'JavaScript', new URL('./mouse.js', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] })
  let lineBuf = '', waiting = null
  helper.stdout.on('data', (d) => { lineBuf += d; const i = lineBuf.indexOf('\n'); if (i >= 0 && waiting) { const l = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1); const w = waiting; waiting = null; w(l) } })
  const where = () => new Promise((res) => { waiting = (l) => { const [x, y] = l.split(',').map(Number); res({ x, y: mainH - y }) }; helper.stdin.write('\n') })
  const t0 = Date.now()
  try {
    const home = await where()
    // 纵向：整张画面的高度正好是所有屏的上下范围按倍数排开（实测吻合），直接算；
    // 横向：苹果会把有的屏左右挪一截（实测各块屏的偏移各不相同），只能量。
    // 苹果的鼠标只能把光标的纵坐标放在其中一排屏里，但横坐标照它自己的对应关系放，所以只读横坐标。
    const minY = Math.min(...screens.map((e) => e.y)), maxY = Math.max(...screens.map((e) => e.y + e.h))
    const minX = Math.min(...screens.map((e) => e.x)), maxX = Math.max(...screens.map((e) => e.x + e.w))
    const ky = H / (maxY - minY)
    let moved = 0, n = 0
    const samples = []
    for (const d of screens) {
      const g = guessRect(d), Y = Math.round((d.y + d.h / 2 - minY) * ky)
      const offs = []
      for (const f of [0.3, 0.5, 0.7]) {
        const X = Math.round(g.x + g.w * f)
        const prev = await where()
        pointer(X, Y)
        await sleep(200)
        const p = await where()
        n++
        samples.push(`${X},${Y}>${Math.round(p.x)},${Math.round(p.y)}`)
        if (Math.abs(p.x - prev.x) > 0.5 || Math.abs(p.y - prev.y) > 0.5) moved++
        // 贴在整个桌面最左/最右的不算（被夹住了）
        if (p.x > minX + 1 && p.x < maxX - 2) offs.push(p.x - X / (d.pw / d.w))
      }
      if (!offs.length) { d.fb = null; continue }
      const off = offs.sort((p, q) => p - q)[offs.length >> 1]
      d.fb = { x: Math.round((d.x - off) * (d.pw / d.w)), y: Math.round((d.y - minY) * ky), w: d.pw, h: d.ph }
    }
    // 鼠标放回原处
    const k = screens.findIndex((d) => d.fb && home.x >= d.x && home.x < d.x + d.w && home.y >= d.y && home.y < d.y + d.h)
    if (mousectl) mousectl.write(`p ${home.x} ${home.y} 0\n`)
    else if (k >= 0) { const d = screens[k]; pointer(d.fb.x + (home.x - d.x) * (d.pw / d.w), d.fb.y + (home.y - d.y) * (d.ph / d.h)) }
    log(`calibrated in ${Date.now() - t0}ms, home ${Math.round(home.x)},${Math.round(home.y)}, cursor moved on ${moved}/${n} samples:`, JSON.stringify(screens.map((d) => d.fb)))
    for (let i = 0; i < samples.length; i += 6) log('samples fb>global', samples.slice(i, i + 6).join(' '))
    const ok = moved > 0 && screens.every((d) => d.fb)
    if (ok) {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true })
      fs.writeFileSync(CACHE, JSON.stringify({ sig, fb: screens.map((d) => d.fb) }))
    } else screens.forEach((d) => { d.fb = null })
    return ok
  } catch (e) { log('calibrate failed', e.message); return false } finally { helper.kill() }
}
// 没校准出来的屏：按系统坐标统一倍数从左上角对齐（老办法，可能偏）
function guessRect(d) {
  const minX = Math.min(...screens.map((e) => e.x)), minY = Math.min(...screens.map((e) => e.y))
  const maxX = Math.max(...screens.map((e) => e.x + e.w)), maxY = Math.max(...screens.map((e) => e.y + e.h))
  const k = Math.max(W / (maxX - minX), H / (maxY - minY))
  return { x: Math.round((d.x - minX) * k), y: Math.round((d.y - minY) * k), w: Math.round(d.w * k), h: Math.round(d.h * k) }
}

function layout() {
  const d = screens[view.index] || screens[0]
  let r = d ? (d.fb || guessRect(d)) : { x: 0, y: 0, w: W, h: H }
  if (screens.length < 2) r = { x: 0, y: 0, w: W, h: H }
  viewRect = r; viewDisp = d
  const x = Math.max(0, Math.min(W - 1, r.x)), y = Math.max(0, Math.min(H - 1, r.y))
  crop = { x, y, w: Math.min(W - x, r.w - (x - r.x)), h: Math.min(H - y, r.h - (y - r.y)) }
  const k = d ? d.pw / d.w : 1 // 一个点几个像素
  s = view.hi ? 1 : Math.max(1, Math.round(k))
  // 宽高取 s 的整数倍，缩完正好是整数
  crop.w -= crop.w % s; crop.h -= crop.h % s
  resetBuffer()
  log(`fb ${W}x${H} screen ${view.index} ${d?.fb ? 'calibrated' : 'guessed'} crop ${crop.x},${crop.y} ${crop.w}x${crop.h} /${s} → ${crop.w / s}x${crop.h / s}`)
}
/** 换了画面来源或尺寸：清空缓冲，等整块收齐再发给手机 */
function resetBuffer() {
  fb = Buffer.alloc(crop.w * crop.h * 3)
  dirty = []
  fresh = false; covered = 0
  tiles = new Uint8Array(Math.ceil(crop.w / TILE) * Math.ceil(crop.h / TILE)); tilesLeft = tiles.length
  clearTimeout(freshTimer)
  freshTimer = setTimeout(() => { if (!fresh) { log(`source sent only ${tiles.length - tilesLeft}/${tiles.length} tiles in 4s`); fresh = true; markAll(); flush() } }, 4000) // 兜底：没给齐也别一直黑着
  sendSize = true; announce = true
}
const markAll = () => { dirty = [{ x: 0, y: 0, w: crop.w, h: crop.h }] }
function addDirty(r) {
  for (let i = 0; i < dirty.length; i++) {
    const d = dirty[i]
    // 挨着或重叠就并成一块
    if (r.x <= d.x + d.w + 16 && d.x <= r.x + r.w + 16 && r.y <= d.y + d.h + 16 && d.y <= r.y + r.h + 16) {
      const x = Math.min(r.x, d.x), y = Math.min(r.y, d.y)
      dirty.splice(i, 1)
      return addDirty({ x, y, w: Math.max(r.x + r.w, d.x + d.w) - x, h: Math.max(r.y + r.h, d.y + d.h) - y })
    }
  }
  dirty.push(r)
  if (dirty.length > 12) {
    const x = Math.min(...dirty.map((d) => d.x)), y = Math.min(...dirty.map((d) => d.y))
    dirty = [{ x, y, w: Math.max(...dirty.map((d) => d.x + d.w)) - x, h: Math.max(...dirty.map((d) => d.y + d.h)) - y }]
  }
}

// ---------- Mac 这头 ----------
// 32 位、小端、R/G/B 依次在低三个字节：一个像素的字节就是 R G B 0，ZRLE 的 CPIXEL 正好是 R G B
const PIXEL_FORMAT = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0])
const ENCODINGS = [16, 0, -223, -224] // ZRLE、Raw、DesktopSize、LastRect
function macRequest(incremental) {
  const b = Buffer.alloc(10)
  b[0] = 3; b[1] = incremental ? 1 : 0
  b.writeUInt16BE(crop.x, 2); b.writeUInt16BE(crop.y, 4); b.writeUInt16BE(crop.w, 6); b.writeUInt16BE(crop.h, 8)
  toMac(b)
}
// 一个矩形（整张画面坐标）跟裁剪区的交集，换成裁剪内坐标
function clip(x, y, w, h) {
  const x0 = Math.max(x, crop.x), y0 = Math.max(y, crop.y)
  const x1 = Math.min(x + w, crop.x + crop.w), y1 = Math.min(y + h, crop.y + crop.h)
  return x1 > x0 && y1 > y0 ? { x: x0 - crop.x, y: y0 - crop.y, w: x1 - x0, h: y1 - y0 } : null
}
// 把 RGB 像素块（宽 sw，左上角在整张画面的 sx,sy）里落在裁剪区内的部分拷进 fb
function blit(src, sx, sy, sw, sh, stride = 3) {
  const c = clip(sx, sy, sw, sh)
  if (!c) return
  for (let row = 0; row < c.h; row++) {
    const srcY = c.y + crop.y - sy, srcX = c.x + crop.x - sx
    let si = ((srcY + row) * sw + srcX) * stride
    let di = ((c.y + row) * crop.w + c.x) * 3
    if (stride === 3) { src.copy(fb, di, si, si + c.w * 3); continue }
    for (let i = 0; i < c.w; i++, si += 4, di += 3) { fb[di] = src[si]; fb[di + 1] = src[si + 1]; fb[di + 2] = src[si + 2] }
  }
}
// ZRLE 整个连接共用一条 zlib 流：每个矩形的数据写进去、同步刷新，拿到这一段解出来的内容
const inflater = zlib.createInflate({ chunkSize: 1 << 20 })
function inflate(z) {
  return new Promise((res, rej) => {
    const out = []
    const on = (d) => out.push(d)
    inflater.on('data', on)
    inflater.once('error', rej)
    inflater.write(z)
    inflater.flush(zlib.constants.Z_SYNC_FLUSH, () => { inflater.off('data', on); inflater.off('error', rej); res(Buffer.concat(out)) })
  })
}
const tile = Buffer.alloc(64 * 64 * 3)
function zrle(data, rx, ry, rw, rh) {
  if (!clip(rx, ry, rw, rh)) return
  let p = 0
  for (let ty = 0; ty < rh; ty += 64) {
    const th = Math.min(64, rh - ty)
    for (let tx = 0; tx < rw; tx += 64) {
      const tw = Math.min(64, rw - tx), n = tw * th
      const sub = data[p++]
      const inside = !!clip(rx + tx, ry + ty, tw, th)
      if (sub === 0) {
        if (inside) blit(data.subarray(p, p + n * 3), rx + tx, ry + ty, tw, th)
        p += n * 3
        continue
      }
      if (sub === 1) {
        if (inside) for (let i = 0; i < n * 3; i += 3) { tile[i] = data[p]; tile[i + 1] = data[p + 1]; tile[i + 2] = data[p + 2] }
        p += 3
      } else if (sub <= 16) {
        const pal = data.subarray(p, p + sub * 3); p += sub * 3
        const bits = sub === 2 ? 1 : sub <= 4 ? 2 : 4, mask = (1 << bits) - 1
        const rowBytes = Math.ceil((tw * bits) / 8)
        if (inside) {
          for (let y = 0; y < th; y++) {
            for (let x = 0; x < tw; x++) {
              const bit = x * bits
              const idx = (data[p + y * rowBytes + (bit >> 3)] >> (8 - bits - (bit & 7))) & mask
              const o = (y * tw + x) * 3
              tile[o] = pal[idx * 3]; tile[o + 1] = pal[idx * 3 + 1]; tile[o + 2] = pal[idx * 3 + 2]
            }
          }
        }
        p += rowBytes * th
      } else if (sub === 128) {
        let i = 0
        while (i < n) {
          const r = data[p], g = data[p + 1], b = data[p + 2]; p += 3
          let len = 1, v
          do { v = data[p++]; len += v } while (v === 255)
          const end = Math.min(n, i + len) * 3
          for (let o = i * 3; o < end; o += 3) { tile[o] = r; tile[o + 1] = g; tile[o + 2] = b }
          i += len
        }
      } else if (sub >= 130) {
        const ps = sub - 128
        const pal = data.subarray(p, p + ps * 3); p += ps * 3
        let i = 0
        while (i < n) {
          let idx = data[p++], len = 1
          if (idx & 128) { idx &= 127; let v; do { v = data[p++]; len += v } while (v === 255) }
          const end = Math.min(n, i + len) * 3
          const r = pal[idx * 3], g = pal[idx * 3 + 1], b = pal[idx * 3 + 2]
          for (let o = i * 3; o < end; o += 3) { tile[o] = r; tile[o + 1] = g; tile[o + 2] = b }
          i += len
        }
      } else throw new Error('bad zrle subencoding ' + sub)
      if (inside) blit(tile, rx + tx, ry + ty, tw, th)
    }
  }
}
function markTiles(c) {
  // 一格的中心落在发来的区域里就算收到了（区域拼满整块时每格正好算一次；最后一行/列不满一格，用实际那一截的中心）
  const cols = Math.ceil(crop.w / TILE), rows = Math.ceil(crop.h / TILE)
  const mid = (i, len) => (i * TILE + Math.min((i + 1) * TILE, len)) / 2
  for (let ty = Math.max(0, Math.floor(c.y / TILE)); ty < rows && ty * TILE < c.y + c.h; ty++) {
    const cy = mid(ty, crop.h)
    if (cy < c.y || cy >= c.y + c.h) continue
    for (let tx = Math.max(0, Math.floor(c.x / TILE)); tx < cols && tx * TILE < c.x + c.w; tx++) {
      const cx = mid(tx, crop.w)
      if (cx < c.x || cx >= c.x + c.w) continue
      const i = ty * cols + tx
      if (!tiles[i]) { tiles[i] = 1; tilesLeft-- }
    }
  }
}
// 黑屏兜底：屏幕共享进程冷启动后的第一个登录连接整场都是黑画面（预热、停掉 mousectl 都没用）。
function litRatio() {
  let n = 0, lit = 0
  for (let i = 0; i < fb.length; i += 3 * 211) { n++; if (fb[i] + fb[i + 1] + fb[i + 2] > 30) lit++ }
  return n ? lit / n : 1
}
// 实测重新要画面没用：那个连接整场都是黑的；但紧接着（1 秒内）重新登录一次就正常。
// 所以连上 15 秒内画面一直全黑，就告诉手机「重连」（DesktopName 报「[r]」，手机用刚输的密码马上重连一次）
const T0 = Date.now()
let blackChecks = 0
setInterval(() => {
  if (win || !fresh || !fb.length || blackChecks < 0) return
  if (litRatio() > 0.01) { blackChecks = -1; return }
  if (++blackChecks < 2 || Date.now() - T0 > 15000) return
  blackChecks = -1
  log('picture stays black (cold screen sharing session), asking the phone to reconnect')
  const nm = Buffer.from('[r]'), l = Buffer.alloc(4); l.writeUInt32BE(nm.length)
  const hdr = Buffer.alloc(4); hdr[0] = 0; hdr.writeUInt16BE(1, 2)
  toPhone(Buffer.concat([hdr, rectHeader(0, 0, 0, 0, -307), l, nm])) // 断不断由手机决定：真是一块黑屏（屏保、显示器关了）时它不会反复重连
}, 1500).unref()
// 诊断：每 5 秒记一次 Mac 发了多少、裁好的画面平均亮度（只是一个数，不看内容）
setInterval(() => {
  if (!fb) return
  let sum = 0, n = 0, lit = 0
  for (let i = 0; i < fb.length; i += 3 * 97) { const v = fb[i] + fb[i + 1] + fb[i + 2]; sum += v; n++; if (v > 30) lit++ }
  log(`stats mac rects ${stats.rects} zrle ${(stats.bytes / 1024).toFixed(0)}KB enc ${JSON.stringify(stats.enc)} tiles ${tiles ? tiles.length - tilesLeft : 0}/${tiles?.length} fresh ${fresh} brightness ${(sum / n / 3).toFixed(1)} lit ${(100 * lit / n).toFixed(0)}%`)
}, 5000).unref()
// ---------- 按窗口看：画面来自 mousectl（ScreenCaptureKit 只录这一个窗口），不走屏幕共享 ----------
// win：{ id, hi, sock, x, y, w, h（窗口在屏幕上的位置，点）, W, H（画面像素）, pid, taken（已切到前台）, prev（之前的前台 app）}
let win = null
/** 发一行命令给 mousectl（单独一条连接），等它回一行 */
function ask(cmd) {
  return new Promise((res) => {
    const c = net.connect(MOUSE_SOCK, () => c.write(cmd + '\n'))
    let buf = ''
    const done = (v) => { clearTimeout(t); c.destroy(); res(v) }
    const t = setTimeout(() => done(''), 5000)
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) done(buf.slice(0, i)) })
    c.on('error', () => done(''))
  })
}
function stopWindow() {
  if (!win) return
  win.sock.destroy()
  win = null
}
/** 回到看整块屏 */
let failNote = '' // 窗口录不到退回看屏时，下一次 DesktopName 带上原因：「[x]原因」
function backToScreens(why) {
  if (why) log('window mode ended:', why)
  stopWindow()
  failNote = why === 'window closed' ? '窗口关掉了' : /^error: /.test(why || '') ? why.slice(7) : ''
  layout()
  macRequest(false)
  flush()
}
function startWindow(id, hi, keep = null) {
  stopWindow()
  // 窗口第一帧到之前别再把屏幕的画面发给手机
  fresh = false; dirty = []; clearTimeout(freshTimer)
  const c = net.connect(MOUSE_SOCK)
  const w = { id, hi, sock: c, x: 0, y: 0, w: 0, h: 0, W: 0, H: 0, pid: 0, taken: false, prev: 0, polling: false, ...keep }
  win = w
  ask('w list').then((l) => { try { w.pid = JSON.parse(l).windows.find((x) => x.id === id)?.pid || 0 } catch {} })
  const r = new Reader()
  c.on('connect', () => c.write(`w stream ${id} ${hi ? 1 : 0}\n`))
  c.on('data', (d) => r.push(d))
  c.on('close', () => r.end())
  c.on('error', (e) => log('window stream error', e.code))
  ;(async () => {
    try {
      for (;;) {
        const t = (await r.need(1))[0]
        if (t === 1) {
          const b = await r.need(4)
          w.W = u16(b, 0); w.H = u16(b, 2)
          if (win !== w) continue
          crop = { x: 0, y: 0, w: w.W, h: w.H }; s = 1
          resetBuffer()
          log(`window ${id} ${w.W}x${w.H}${hi ? ' sharp' : ''}`)
        } else if (t === 2) {
          const b = await r.need(8)
          const x = u16(b, 0), y = u16(b, 2), rw = u16(b, 4), rh = u16(b, 6)
          const px = await r.need(rw * rh * 4)
          if (win !== w || x + rw > crop.w || y + rh > crop.h) continue
          // BGRA → RGB
          for (let row = 0; row < rh; row++) {
            let si = row * rw * 4, di = ((y + row) * crop.w + x) * 3
            for (let i = 0; i < rw; i++, si += 4, di += 3) { fb[di] = px[si + 2]; fb[di + 1] = px[si + 1]; fb[di + 2] = px[si] }
          }
          const c2 = { x, y, w: rw, h: rh }
          stats.rects++
          addDirty(c2); markTiles(c2)
          if (!fresh && tilesLeft === 0) { fresh = true; clearTimeout(freshTimer); markAll() }
          flush()
        } else if (t === 3) {
          const b = await r.need(12)
          w.x = b.readInt32BE(0); w.y = b.readInt32BE(4); w.w = u16(b, 8); w.h = u16(b, 10)
        } else if (t === 5) {
          // 窗口不在屏幕上（别的桌面 / 台前调度收起来），mousectl 退成定时截图：告诉手机
          w.polling = (await r.need(1))[0] === 1
          // 拿不到实时画面（别的桌面、台前调度收起）：直接切到前台再重新录（人多半不在电脑前，抢前台无所谓）
          if (w.polling && win === w && !w.raised) {
            w.raised = true
            log(`window ${w.id} not on screen, bringing it forward`)
            await takeOver()
            await sleep(500)
            if (win === w) startWindow(w.id, w.hi, { taken: w.taken, prev: w.prev, raised: true })
            return
          }
          if (win === w && fresh) { announce = true; flush() }
        } else if (t === 4) {
          if (win === w) backToScreens('window closed')
          return
        } else if (t === 101) {
          // 「error: ...」一行
          let line = 'e'
          for (;;) { const ch = (await r.need(1))[0]; if (ch === 10) break; line += String.fromCharCode(ch) }
          if (win === w) backToScreens(line)
          return
        } else throw new Error('bad window stream byte ' + t)
      }
    } catch (e) { if (win === w) backToScreens(e.message) }
  })()
}
/** 第一次点窗口时把它切到前台（之后点击、按键都照常走全局） */
async function takeOver() {
  const w = win
  if (!w || w.taken) return
  const prev = Number(await ask(`a ${w.id}`)) || 0
  if (win !== w) return
  w.taken = true
  if (prev && prev !== w.pid) w.prev = prev
  log(`window ${w.id} taken over`)
  await sleep(200) // 等切桌面、窗口提上来
}
// 键盘：窗口模式下还没切到前台时，直接发给那个 app 的进程（不抢前台）
const keyCmd = (code, flags, down) => (win && !win.taken && win.pid ? `K ${win.pid} ${code} ${flags} ${down ? 1 : 0}\n` : `k ${code} ${flags} ${down ? 1 : 0}\n`)
const textCmd = (text) => (win && !win.taken && win.pid ? `T ${win.pid} ${Buffer.from(text).toString('base64')}\n` : `t ${Buffer.from(text).toString('base64')}\n`)

async function macLoop() {
  for (;;) {
    const t = (await fromMac.need(1))[0]
    if (t === 0) {
      await fromMac.need(1)
      let n = u16(await fromMac.need(2))
      while (n-- > 0) {
        const h = await fromMac.need(12)
        const x = u16(h, 0), y = u16(h, 2), w = u16(h, 4), hh = u16(h, 6), e = h.readInt32BE(8)
        if (e === -224) break
        if (e === -223) { W = w; H = hh; loadScreens(); if (!win) { layout(); macRequest(false) }; continue }
        // 看窗口时 Mac 那头还在路上的数据照样读完（zlib 流要连续），但不画
        if (e === 0) { const px = await fromMac.need(w * hh * 4); if (!win) blit(px, x, y, w, hh, 4) }
        else if (e === 16) {
          const z = await fromMac.need(u32(await fromMac.need(4)))
          stats.bytes += z.length
          const d = await inflate(z)
          if (!win) zrle(d, x, y, w, hh)
        } else throw new Error('unexpected encoding ' + e)
        if (win) continue
        const c = clip(x, y, w, hh)
        stats.rects++; stats.enc[e] = (stats.enc[e] || 0) + 1
        if (c) { addDirty(c); covered += c.w * c.h; markTiles(c) }
      }
      if (win) continue // 看窗口时不再向 Mac 要画面
      if (!fresh && tilesLeft === 0) { fresh = true; clearTimeout(freshTimer); markAll() }
      macRequest(true)
      flush()
    } else if (t === 2) toPhone(Buffer.from([2]))
    else if (t === 3) { const h = await fromMac.need(7); toPhone(Buffer.concat([Buffer.from([3]), h, await fromMac.need(u32(h, 3))])) }
    else throw new Error('unexpected server message ' + t)
  }
}

// ---------- 手机这头 ----------
let phoneWants = false, flushing = false
let quality = 70
const QUALITY = [20, 30, 40, 50, 60, 70, 75, 80, 88, 95] // noVNC 的画质档 0–9 → JPEG 质量
const compactLen = (n) => (n < 128 ? [n] : n < 16384 ? [(n & 127) | 128, n >> 7] : [(n & 127) | 128, ((n >> 7) & 127) | 128, n >> 14])
function rectHeader(x, y, w, h, e) {
  const b = Buffer.alloc(12)
  b.writeUInt16BE(x, 0); b.writeUInt16BE(y, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); b.writeInt32BE(e, 8)
  return b
}
async function jpegRect(r) {
  // 对齐到 s 的整数倍，缩完边界还是整像素
  const x = r.x - (r.x % s), y = r.y - (r.y % s)
  const w = Math.min(crop.w - x, Math.ceil((r.x + r.w - x) / s) * s), h = Math.min(crop.h - y, Math.ceil((r.y + r.h - y) / s) * s)
  // 先同步拷出来，编码期间 Mac 那边继续往 fb 里写也不会撕裂
  const buf = Buffer.allocUnsafe(w * h * 3)
  for (let row = 0; row < h; row++) fb.copy(buf, row * w * 3, ((y + row) * crop.w + x) * 3, ((y + row) * crop.w + x + w) * 3)
  let img = sharp(buf, { raw: { width: w, height: h, channels: 3 } })
  if (s > 1) img = img.resize(w / s, h / s, { kernel: 'mitchell' })
  const jpg = await img.jpeg({ quality, chromaSubsampling: quality >= 88 ? '4:4:4' : '4:2:0' }).toBuffer()
  return Buffer.concat([rectHeader(x / s, y / s, w / s, h / s, 7), Buffer.from([0x90, ...compactLen(jpg.length)]), jpg])
}
async function flush() {
  if (!phoneWants || flushing || !fresh || (!dirty.length && !sendSize && !announce)) return
  flushing = true; phoneWants = false
  const rects = dirty; dirty = []
  const parts = []
  if (sendSize) { parts.push(rectHeader(0, 0, crop.w / s, crop.h / s, -223)); sendSize = false }
  parts.push(...(await Promise.all(rects.map(jpegRect))))
  if (announce) {
    // 窗口模式报「[w]窗口号」，手机据此知道现在看的是窗口还是屏（窗口关了自动退回看屏时也能知道）
    const nm = Buffer.from(win ? `[w]${win.id}${win.polling ? 'p' : win.raised ? 'f' : ''}` : failNote ? `[x]${failNote}` : name || 'Mac')
    failNote = ''
    const l = Buffer.alloc(4); l.writeUInt32BE(nm.length)
    parts.push(Buffer.concat([rectHeader(0, 0, 0, 0, -307), l, nm]))
    announce = false
  }
  const hdr = Buffer.alloc(4); hdr[0] = 0; hdr.writeUInt16BE(parts.length, 2)
  toPhone(Buffer.concat([hdr, ...parts]))
  flushing = false
  flush()
}
async function phoneLoop() {
  for (;;) {
    const t = (await fromPhone.need(1))[0]
    if (t === 0) await fromPhone.need(19) // SetPixelFormat：JPEG 用不上
    else if (t === 2) {
      const n = u16(await fromPhone.need(3), 1)
      const e = await fromPhone.need(4 * n)
      for (let i = 0; i < n; i++) { const v = e.readInt32BE(i * 4); if (v >= -32 && v <= -23) quality = QUALITY[v + 32] }
    } else if (t === 3) {
      const b = await fromPhone.need(9)
      if (!b[0]) markAll()
      phoneWants = true
      flush()
    } else if (t === 4) {
      const b = await fromPhone.need(7)
      if (!mousectl || !keyToMousectl(b[0] === 1, u32(b, 3))) toMac(Buffer.concat([Buffer.from([4]), b]))
    } else if (t === 251) {
      // 一段文字：[251, 长度 u32, UTF-8]。有 mousectl 就让它粘贴进去，没有就逐字按键发给屏幕共享
      const text = (await fromPhone.need(u32(await fromPhone.need(4)))).toString('utf8')
      if (mousectl) mousectl.write(textCmd(text))
      else for (const ch of text) {
        const cp = ch.codePointAt(0), sym = cp < 0x100 ? cp : 0x01000000 | cp
        for (const down of [1, 0]) { const k = Buffer.from([4, down, 0, 0, 0, 0, 0, 0]); k.writeUInt32BE(sym, 4); toMac(k) }
      }
    } else if (t === 5) {
      const b = await fromPhone.need(5)
      const half = s > 1 ? s >> 1 : 0
      const x = crop.x + Math.min(crop.w - 1, u16(b, 1) * s + half), y = crop.y + Math.min(crop.h - 1, u16(b, 3) * s + half)
      if (win) {
        // 窗口模式：按下任何键（含滚轮）先把窗口切到前台，之后按窗口位置换成全局点；没切过去之前光标移动不管（别在后台乱挪用户的光标）
        if (!mousectl || !win.w) continue
        if (b[0] && !win.taken) await takeOver()
        if (!win?.taken) continue
        const k = win.W / win.w
        mousectl.write(`p ${(win.x + x / k).toFixed(1)} ${(win.y + y / k).toFixed(1)} ${b[0]}\n`)
      } else if (mousectl && viewDisp) {
        const k = viewDisp.pw / viewDisp.w
        mousectl.write(`p ${(viewDisp.x + (x - viewRect.x) / k).toFixed(1)} ${(viewDisp.y + (y - viewRect.y) / k).toFixed(1)} ${b[0]}\n`)
      } else {
        const o = Buffer.from([5, b[0], 0, 0, 0, 0]); o.writeUInt16BE(x, 2); o.writeUInt16BE(y, 4)
        toMac(o)
      }
    } else if (t === 6) { const h = await fromPhone.need(7); toMac(Buffer.concat([Buffer.from([6]), h, await fromPhone.need(u32(h, 3))])) }
    else if (t === 250) {
      // 换屏 / 换清晰度：[250, 显示器序号, 清晰 0/1]
      const b = await fromPhone.need(2)
      view = { index: b[0], hi: b[1] === 1 }
      stopWindow()
      layout()
      macRequest(false)
      flush()
    } else if (t === 252) {
      // 看某个窗口：[252, 窗口号 u32, 清晰 0/1, 先切到前台 0/1]（台前调度收起来的窗口只剩缩略图大小，得先切出来）
      const b = await fromPhone.need(6)
      if (mousectl) {
        startWindow(u32(b, 0), b[4] === 1)
        if (b[5] === 1) { await takeOver(); await sleep(500); if (win) startWindow(win.id, win.hi, { taken: win.taken, prev: win.prev }) }
      }
      else log('window mode needs mousectl')
    } else if (t === 253) {
      // 把之前的前台 app 切回来
      if (win?.prev) { mousectl?.write(`r ${win.prev}\n`); log('restored front app') }
      if (win) win.taken = false
    } else throw new Error('unexpected client message ' + t)
  }
}

try {
  const init = await handshake()
  W = init.W; H = init.H; name = init.name
  const cached = loadScreens()
  layout()
  // 给手机的 ServerInit：裁好缩好的尺寸，名字先空着（画面到了再用 DesktopName 告诉它）
  const si = Buffer.alloc(24)
  si.writeUInt16BE(crop.w / s, 0); si.writeUInt16BE(crop.h / s, 2); init.pf.copy(si, 4)
  toPhone(si)
  sendSize = false
  toMac(Buffer.concat([PIXEL_FORMAT]))
  const se = Buffer.alloc(4 + 4 * ENCODINGS.length); se[0] = 2; se.writeUInt16BE(ENCODINGS.length, 2)
  ENCODINGS.forEach((e, i) => se.writeInt32BE(e, 4 + 4 * i))
  toMac(se)
  macRequest(false)
  const loops = Promise.all([macLoop(), phoneLoop()])
  if (!cached) {
    // 先按估算的位置出画面，画面到了再在后台校准，算出来了换成准确的
    const t0 = Date.now()
    while (!fresh && Date.now() - t0 < 8000) await sleep(100)
    if ((await calibrate()) && !win) { layout(); macRequest(false) }
  }
  await loops
} catch (e) {
  if (e.message !== 'eof') log(e.message)
  // 让刚写给手机的数据（比如认证失败的原因）先发出去
  process.stdout.write('', () => { mac.destroy(); process.exit(0) })
}
