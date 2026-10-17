// 手机预览：在电脑上控制一个独立的无界面 Chrome（单独的用户目录，cookie / 登录和日常 Chrome 隔开），
// 网络完全走这台电脑（localhost、内网、系统代理都照用）。由 bridge 的 preview 命令启动，
// stdin / stdout 是和中转服务器之间的通道，每行一个 JSON。
//
// 收（中转 → 这里）：open{url} viewport{w,h,dpr,desktop} tap{x,y} hover{x,y} scroll{x,y,dy} text{s} key{key}
//                   back forward reload ack{seq} tabs switch{id} close{id} new{url}
// 发（这里 → 中转）：frame{seq,w,h,data(base64 jpeg)} nav{url,title,loading} tabs{list,current} error{msg} ready
//
// 出图：无界面 Chrome 的 screencast 只按 CSS 像素出图（手机上发糊），所以 screencast 只当「画面变了」的门铃
// （最小尺寸、最低画质），真正的帧用 captureScreenshot 按手机像素密度截。
// 流控：同一时间只有一帧在路上，手机画完 ack 了才截下一张；中间画面变了多少次都合并成一张最新的，
// 帧率自动跟着手机那头的网速走，网络慢不会积压。
// 电脑模式（viewport.desktop）：UA / client hints 换成 Mac 上的 Chrome，按 DESKTOP_W 宽的桌面窗口渲染（高度按手机画面比例），
// 关掉触屏模拟，轻点发鼠标点击；手机那头缩放显示。帧里的 w / h 都是页面的 CSS 尺寸，手机按它换算坐标。
//
// node preview-agent.mjs --stop  关掉预览用的 Chrome
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const DIR = process.env.PREVIEW_DIR || path.join(os.homedir(), '.local/share/pane-remote/preview') // PREVIEW_DIR：测试用的独立目录
const PROFILE = path.join(DIR, 'profile')
const PIDFILE = path.join(DIR, 'chrome.pid')
const CHROME = process.env.PREVIEW_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HOME_URL = 'about:blank'
const DESKTOP_W = Number(process.env.PREVIEW_DESKTOP_W || 1280)
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => process.stderr.write(`[preview] ${a.join(' ')}\n`)

function chromePid() {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch { return 0 }
}

function stopChrome() {
  const pid = chromePid()
  if (pid) { try { process.kill(pid) } catch {} }
  try { fs.unlinkSync(PIDFILE) } catch {}
  return pid
}

if (process.argv.includes('--stop')) {
  const pid = stopChrome()
  console.log(pid ? `stopped ${pid}` : 'not running')
  process.exit(0)
}

// Chrome 退出后 DevToolsActivePort 可能还留着，所以先确认进程在
async function browserWsUrl() {
  fs.mkdirSync(PROFILE, { recursive: true })
  const portFile = path.join(PROFILE, 'DevToolsActivePort')
  if (!chromePid()) {
    try { fs.unlinkSync(portFile) } catch {}
    const child = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', HOME_URL,
    ], { detached: true, stdio: 'ignore' }) // 脱离会话：ssh 断开后 Chrome 留着，标签页和登录状态都在
    child.unref()
    fs.writeFileSync(PIDFILE, String(child.pid))
    log('started chrome', child.pid)
  }
  for (let i = 0; i < 100; i++) {
    try {
      const [port] = fs.readFileSync(portFile, 'utf8').split('\n')
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      return v.webSocketDebuggerUrl
    } catch { await sleep(100) }
  }
  throw new Error('Chrome 没起来')
}

// ---------- CDP（一条浏览器级连接，页面用 flatten session） ----------
const ws = new WebSocket(await browserWsUrl())
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('连不上 Chrome')) })
let nextId = 0
const pending = new Map()
const handlers = new Map() // method → fn(params, sessionId)
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    if (m.error) p?.reject(new Error(m.error.message))
    else p?.resolve(m.result)
  } else handlers.get(m.method)?.(m.params, m.sessionId)
}
ws.onclose = () => { out({ t: 'error', msg: '和 Chrome 的连接断了' }); process.exit(1) }

// ---------- 文件浏览器：给预览里的 Chrome 看电脑上的文件夹和各种文件 ----------
// 只监听 127.0.0.1，路径前面带随机令牌：别的网页猜不到地址，读不到文件。只允许家目录和 /tmp。
// /<令牌>/view?p=路径  文件夹 → 列表；文件 → 按类型显示（图片 / 视频 / 音频 / PDF / Markdown / 代码文本 / CSV）
// /<令牌>/raw?p=路径   原始文件（支持 Range，视频能拖进度）
const TOKEN = crypto.randomUUID().replaceAll('-', '')
const HOME = os.homedir()
// 查看器用的脚本库都从本机 node_modules 提供（不走 CDN：这个来源握着读文件的令牌，外部脚本一旦被篡改就能读走所有文件）
const APP_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const VENDOR = {
  'marked.js': 'marked/lib/marked.umd.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'hljs.js': '@highlightjs/cdn-assets/highlight.min.js',
  'hljs.css': '@highlightjs/cdn-assets/styles/github.min.css',
  'pdf.mjs': 'pdfjs-dist/build/pdf.min.mjs',
  'pdf.worker.mjs': 'pdfjs-dist/build/pdf.worker.min.mjs',
}
// 每个页面一个随机 nonce：只有我们自己写的 <script nonce> 能执行（CSP），文件内容里混进来的脚本一律不跑
let NONCE = ''
const vendorUrl = (k) => `${filesBase}/vendor/${k}`
const vscript = (k) => `<script nonce="${NONCE}" src="${esc(vendorUrl(k))}"></script>`
const vcss = (k) => `<link rel="stylesheet" href="${esc(vendorUrl(k))}">`
// 嵌进 <script type="application/json"> 的数据：< > & 和两个行分隔符都转义，内容里的 </script> 关不掉标签
const jsonForScript = (o) => JSON.stringify(o).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
const dataBlock = (o) => `<script type="application/json" id="data">${jsonForScript(o)}</script>`
const EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'],
  video: ['mp4', 'mov', 'webm', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'],
  md: ['md', 'markdown', 'mdx'],
  csv: ['csv', 'tsv'],
  html: ['html', 'htm', 'xhtml'],
}
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  pdf: 'application/pdf', json: 'application/json',
}
// 代码高亮用的语言名（highlight.js），不在表里的文本按纯文本显示
const LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', css: 'css', scss: 'scss', less: 'less', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', vue: 'xml', svelte: 'xml', sql: 'sql', lua: 'lua', dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', patch: 'diff' }
const extOf = (p) => { const b = path.basename(p).toLowerCase(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : b }
const kindOf = (p) => { const e = extOf(p); for (const [k, list] of Object.entries(EXT)) if (list.includes(e)) return k; return e === 'pdf' ? 'pdf' : 'other' }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const tilde = (p) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`
const fmtTime = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }

function resolveSafe(input) {
  let p = String(input || '').trim()
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1)
  if (!p.startsWith('/')) return null
  try { p = fs.realpathSync(p) } catch { return null }
  const ok = p === HOME || p.startsWith(HOME + '/') || /^\/(private\/)?tmp(\/|$)/.test(p)
  return ok ? p : null
}
let filesBase = ''
const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/')
const viewUrl = (p) => `${filesBase}/view?p=${encodeURIComponent(p)}`
const rawUrl = (p) => `${filesBase}/raw?p=${encodeURIComponent(p)}`
/** 预览里的地址 → 地址栏显示的样子（文件浏览器的地址显示成 ~/路径） */
function displayUrl(u) {
  if (/^file:\/\//i.test(u)) { try { return tilde(decodeURIComponent(new URL(u).pathname)) } catch { return u } }
  if (!filesBase || !u.startsWith(filesBase + '/view?')) return u
  try { return tilde(new URL(u).searchParams.get('p') || '') } catch { return u }
}

const PAGE_CSS = `
:root{color-scheme:light;--fg:#1f2328;--mut:#656d76;--line:#e5e7eb;--hi:#f3f4f6;--acc:#0969da}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:var(--fg);background:#fff}
header{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);padding:10px 14px}
.crumbs{display:flex;flex-wrap:wrap;gap:2px;align-items:center;font-size:14px}.crumbs a{color:var(--acc);text-decoration:none;padding:2px 4px;border-radius:4px}.crumbs span{color:var(--mut)}
.meta{color:var(--mut);font-size:12.5px;margin-top:2px}
a.row{display:flex;align-items:center;gap:12px;padding:9px 14px;min-height:52px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}a.row:active{background:var(--hi)}
.ic{width:36px;height:36px;flex:none;display:grid;place-items:center;font-size:22px;border-radius:6px;overflow:hidden;background:var(--hi)}.ic img{width:100%;height:100%;object-fit:cover}
.nm{flex:1;min-width:0}.nm b{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nm small{color:var(--mut);font-size:12px}
.empty{padding:40px;text-align:center;color:var(--mut)}
main{padding:14px}main.media{display:grid;place-items:center;min-height:calc(100vh - 70px);background:#111;padding:0}
main.media img,main.media video{max-width:100%;max-height:calc(100vh - 70px)}
pre{margin:0;padding:12px 14px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
pre.hljs,code.hljs{background:#fff}
.md{max-width:900px;margin:0 auto;padding:6px 18px 40px}.md img{max-width:100%}.md pre{background:#f6f8fa;border-radius:6px}.md code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}.md table{border-collapse:collapse}.md td,.md th{border:1px solid var(--line);padding:4px 8px}
table.csv{border-collapse:collapse;font-size:13px}table.csv td,table.csv th{border:1px solid var(--line);padding:4px 8px;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}table.csv th{background:var(--hi);position:sticky;top:0}
.note{margin:14px;padding:10px 12px;border-radius:8px;background:#fff8c5;font-size:13px}
.card{max-width:520px;margin:30px auto;padding:20px;border:1px solid var(--line);border-radius:12px}.card dt{color:var(--mut);font-size:12px;margin-top:10px}.card dd{margin:0;word-break:break-all}
.pdfpage{display:block;margin:0 auto 12px;max-width:100%;box-shadow:0 1px 4px rgba(0,0,0,.2);background:#fff}main.pdf{background:#e5e7eb}`

function crumbs(p) {
  const t = tilde(p)
  const parts = t.split('/').filter(Boolean)
  let acc = t.startsWith('~') ? HOME : ''
  const links = parts.map((seg, i) => {
    if (i === 0 && seg === '~') return `<a href="${esc(viewUrl(HOME))}">~</a>`
    acc += '/' + seg
    return `<a href="${esc(viewUrl(acc))}">${esc(seg)}</a>`
  })
  // 层级太深：只留开头一层和最后三层，中间折成「…」
  const shown = links.length > 5 ? [links[0], '<span>…</span>', ...links.slice(-3)] : links
  return `<div class="crumbs">${t.startsWith('~') ? '' : '<span>/</span>'}${shown.join('<span>/</span>')}</div>`
}
const htmlPage = (title, p, meta, body, head = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style>${head}</head><body><header>${crumbs(p)}<div class="meta">${meta}</div></header>${body}</body></html>`

function icon(name, dir) {
  if (dir) return '📁'
  const k = kindOf(name), e = extOf(name)
  return { image: '🖼️', video: '🎬', audio: '🎵', md: '📝', csv: '📊', html: '🌐', pdf: '📕' }[k] || (LANG[e] || ['txt', 'log'].includes(e) ? '📄' : ['zip', 'gz', 'tgz', 'rar', '7z', 'dmg', 'tar'].includes(e) ? '📦' : '📎')
}

function dirPage(p, showHidden) {
  let list = []
  try { list = fs.readdirSync(p, { withFileTypes: true }) } catch (e) { return htmlPage(path.basename(p), p, '打不开', `<p class="empty">${esc(e.message)}</p>`) }
  const hidden = list.filter((e) => e.name.startsWith('.')).length
  if (!showHidden) list = list.filter((e) => !e.name.startsWith('.'))
  const rows = list.map((e) => {
    const full = path.join(p, e.name)
    let st = null
    try { st = fs.statSync(full) } catch {}
    return { name: e.name, full, dir: !!st?.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 }
  }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh', { numeric: true }) : a.dir ? -1 : 1))
  const shown = rows.slice(0, 2000)
  const up = p !== '/' && resolveSafe(path.dirname(p)) ? `<a class="row" href="${esc(viewUrl(path.dirname(p)))}"><span class="ic">⬆️</span><span class="nm"><b>上一级</b></span></a>` : ''
  const html = shown.map((r) => {
    const thumb = !r.dir && kindOf(r.name) === 'image' && r.size < 30 * 1048576 ? `<img loading="lazy" src="${esc(rawUrl(r.full))}">` : icon(r.name, r.dir)
    const sub = r.dir ? fmtTime(r.mtime) : `${fmtSize(r.size)} · ${fmtTime(r.mtime)}`
    return `<a class="row" href="${esc(viewUrl(r.full))}"><span class="ic">${thumb}</span><span class="nm"><b>${esc(r.name)}</b><small>${sub}</small></span></a>`
  }).join('')
  const dirs = rows.filter((r) => r.dir).length
  const toggle = hidden ? ` · <a href="${esc(viewUrl(p) + (showHidden ? '' : '&hidden=1'))}">${showHidden ? '不显示' : '显示'} ${hidden} 个隐藏项</a>` : ''
  const meta = `${dirs} 个文件夹 · ${rows.length - dirs} 个文件${rows.length > shown.length ? `（只列前 ${shown.length} 个）` : ''}${toggle}`
  return htmlPage(path.basename(p) || '/', p, meta, up + (html || '<p class="empty">空文件夹</p>'))
}

function readHead(p, max) {
  const fd = fs.openSync(p, 'r')
  try { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, 0); return b.subarray(0, n) } finally { fs.closeSync(fd) }
}
const isText = (buf) => !buf.subarray(0, 8000).includes(0)

function parseCsv(text, sep) {
  const rows = []; let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c; continue }
    if (c === '"') q = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; if (rows.length >= 2000) return rows }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function filePage(p) {
  const st = fs.statSync(p)
  const name = path.basename(p), k = kindOf(p), e = extOf(p)
  const meta = `${fmtSize(st.size)} · ${fmtTime(st.mtimeMs)} · <a href="${esc(viewUrl(path.dirname(p)))}">所在文件夹</a>`
  const raw = esc(rawUrl(p))
  if (k === 'image') return htmlPage(name, p, meta, `<main class="media"><img src="${raw}"></main>`)
  if (k === 'video') return htmlPage(name, p, meta, `<main class="media"><video src="${raw}" controls playsinline preload="metadata"></video></main>`)
  if (k === 'audio') return htmlPage(name, p, meta, `<main><audio src="${raw}" controls preload="metadata" style="width:100%"></audio></main>`)
  if (k === 'pdf') {
    return htmlPage(name, p, meta + ' · <span id="pg">加载中…</span>', `<main class="pdf" id="pdf"></main>${dataBlock({ raw: rawUrl(p), lib: vendorUrl('pdf.mjs'), worker: vendorUrl('pdf.worker.mjs') })}`, `<script type="module" nonce="${NONCE}">
const d = JSON.parse(document.getElementById('data').textContent)
const pdfjs = await import(d.lib)
pdfjs.GlobalWorkerOptions.workerSrc = d.worker
const doc = await pdfjs.getDocument(d.raw).promise
const box = document.getElementById('pdf'); document.getElementById('pg').textContent = doc.numPages + ' 页'
const io = new IntersectionObserver((es) => es.forEach(async (en) => { if (!en.isIntersecting || en.target.dataset.done) return; en.target.dataset.done = 1; io.unobserve(en.target)
  const pg = await doc.getPage(+en.target.dataset.n); const w = box.clientWidth - 24; const v0 = pg.getViewport({ scale: 1 }); const s = w / v0.width; const v = pg.getViewport({ scale: s * devicePixelRatio })
  const c = en.target; c.width = v.width; c.height = v.height; c.style.width = w + 'px'; c.style.height = v.height / devicePixelRatio + 'px'
  await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise }), { rootMargin: '800px' })
const first = await doc.getPage(1); const r = first.getViewport({ scale: 1 }); const w = box.clientWidth - 24
for (let n = 1; n <= doc.numPages; n++) { const c = document.createElement('canvas'); c.className = 'pdfpage'; c.dataset.n = n; c.style.width = w + 'px'; c.style.height = (w * r.height / r.width) + 'px'; box.append(c); io.observe(c) }
box.style.padding = '12px'
</script>`)
  }
  const MAX = 2 * 1048576
  const head = readHead(p, Math.min(st.size, MAX))
  if (!isText(head)) {
    return htmlPage(name, p, meta, `<div class="card"><b>${esc(name)}</b><dl><dt>类型</dt><dd>${esc(e.toUpperCase())} 文件（预览不了，不是文本）</dd><dt>大小</dt><dd>${fmtSize(st.size)}</dd><dt>修改时间</dt><dd>${fmtTime(st.mtimeMs)}</dd><dt>位置</dt><dd>${esc(tilde(p))}</dd></dl></div>`)
  }
  const text = head.toString('utf8')
  const cut = st.size > MAX ? `<p class="note">文件有 ${fmtSize(st.size)}，只显示前 2 MB</p>` : ''
  if (k === 'md') {
    // marked 出来的 HTML 先过 DOMPurify（去掉脚本、事件属性、javascript: 链接），再把相对路径的图片 / 链接改成走文件浏览器
    return htmlPage(name, p, meta, `${cut}<article class="md" id="md"></article>${dataBlock({ text, base: path.dirname(p), raw: `${filesBase}/raw?p=`, view: `${filesBase}/view?p=` })}`,
      `${vcss('hljs.css')}${vscript('marked.js')}${vscript('purify.js')}${vscript('hljs.js')}<script nonce="${NONCE}">
addEventListener('DOMContentLoaded', () => {
  const d = JSON.parse(document.getElementById('data').textContent)
  const el = document.getElementById('md')
  try { el.innerHTML = DOMPurify.sanitize(marked.parse(d.text), { USE_PROFILES: { html: true } }) } catch { el.textContent = d.text; return }
  el.querySelectorAll('img[src], a[href]').forEach((n) => {
    const at = n.tagName === 'IMG' ? 'src' : 'href'
    const v = n.getAttribute(at)
    if (!v || /^([a-z][a-z0-9+.-]*:|#|\\/\\/)/i.test(v)) return
    let rel = v.split('#')[0]
    try { rel = decodeURI(rel) } catch {}
    const abs = rel.startsWith('/') ? rel : d.base + '/' + rel
    n.setAttribute(at, (n.tagName === 'IMG' ? d.raw : d.view) + encodeURIComponent(abs))
  })
  el.querySelectorAll('pre code').forEach((c) => { try { hljs.highlightElement(c) } catch {} })
})
</script>`)
  }
  if (k === 'csv') {
    const rows = parseCsv(text, e === 'tsv' ? '\t' : ',')
    const [h = [], ...body] = rows
    const table = `<table class="csv"><thead><tr>${h.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    return htmlPage(name, p, `${meta} · ${body.length}${rows.length >= 2000 ? '+' : ''} 行`, `${cut}<div style="overflow:auto">${table}</div>`)
  }
  let lang = LANG[e] || LANG[name.toLowerCase()] || ''
  let shown = text
  if (e === 'json' && st.size <= MAX) { try { shown = JSON.stringify(JSON.parse(text), null, 2) } catch {} }
  // 太大的文本不高亮（几十万字符时 highlight.js 会卡住页面）
  const hl = lang && shown.length <= 400000 ? `${vcss('hljs.css')}${vscript('hljs.js')}<script nonce="${NONCE}">addEventListener('DOMContentLoaded', () => { try { hljs.highlightElement(document.querySelector('pre code')) } catch {} })</script>` : ''
  return htmlPage(name, p, meta, `${cut}<pre><code class="${lang ? 'language-' + lang : ''}">${esc(shown)}</code></pre>`, hl)
}

function sendRaw(req, res, p) {
  const st = fs.statSync(p)
  const type = MIME[extOf(p)] || 'application/octet-stream'
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
    if (start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end() }
    res.writeHead(206, { ...RAW_HEADERS, 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' })
    return fs.createReadStream(p, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...RAW_HEADERS, 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' })
  fs.createReadStream(p).pipe(res)
}
// 原始文件当成数据给出：直接打开时（比如 SVG）也在沙箱里，里面的脚本不能跑、不能读这个来源
const RAW_HEADERS = { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
const pageCsp = () => [
  "default-src 'none'",
  `script-src 'nonce-${NONCE}' ${filesBase}/vendor/`,
  `worker-src ${filesBase}/vendor/ blob:`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const fileServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const [, token, route] = u.pathname.split('/')
  if (token !== TOKEN) { res.writeHead(404); return res.end() }
  if (route === 'vendor') {
    const key = u.pathname.split('/')[3] || ''
    const rel = Object.hasOwn(VENDOR, key) ? VENDOR[key] : ''
    const f = rel && path.join(APP_DIR, 'node_modules', rel)
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript', 'x-content-type-options': 'nosniff', 'cache-control': 'max-age=3600' })
    return fs.createReadStream(f).on('error', () => res.end()).pipe(res)
  }
  const p = resolveSafe(u.searchParams.get('p'))
  if (!p) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('只能看家目录和 /tmp 里的文件，或者文件不存在') }
  try {
    if (route === 'raw') return sendRaw(req, res, p)
    if (route !== 'view') { res.writeHead(404); return res.end() }
    const isDir = fs.statSync(p).isDirectory()
    // 网页文件要用 file:// 打开（相对路径的图片、脚本才找得到，也照 Chrome 本地文件的规矩不能读别的文件）。
    // http 页面不能跳到 file://（重定向、链接都会被拦），所以由这边用 DevTools 让当前标签页直接打开
    if (!isDir && kindOf(p) === 'html') {
      const sid = pages.get(current)?.sessionId
      if (sid) setTimeout(() => cdp('Page.navigate', { url: fileUrl(p) }, sid).catch(() => {}), 0)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<meta charset="utf-8">正在打开网页文件…')
    }
    NONCE = crypto.randomBytes(16).toString('base64')
    const html = isDir ? dirPage(p, u.searchParams.has('hidden')) : filePage(p)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': pageCsp(), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message)
  }
})
await new Promise((r) => fileServer.listen(0, '127.0.0.1', r))
filesBase = `http://127.0.0.1:${fileServer.address().port}/${TOKEN}`

// ---------- 页面 ----------
const pages = new Map() // targetId → { sessionId, url, title }
let current = null // targetId
let view = { w: 390, h: 700, dpr: 2, desktop: false }
// 页面实际的 CSS 尺寸和截图倍率：手机模式就是手机画面；电脑模式宽 DESKTOP_W，高按手机画面比例
let page = { w: 390, h: 700, dpr: 2 }
let seq = 0
let inflight = 0 // 发给手机、还没 ack 的帧序号
let capturing = false
let dirty = false // 有没有还没发出去的画面变化
let inflightAt = 0
const QUALITY = Number(process.env.PREVIEW_QUALITY || 70)
// 操作中（点、滑、打字后一小会儿）先发低清小图，手机那头跟手；停手后再补一张清楚的
const FAST_MS = 650
let lastInput = 0
let sharpTimer
function touched() {
  lastInput = Date.now()
  clearTimeout(sharpTimer)
  sharpTimer = setTimeout(() => { dirty = true; pump() }, FAST_MS + 50)
}

function sendTabs() {
  out({ t: 'tabs', current, list: [...pages].map(([id, p]) => ({ id, url: displayUrl(p.url), title: p.title })) })
}
function sendNav() {
  const p = pages.get(current)
  if (p) out({ t: 'nav', url: displayUrl(p.url), title: p.title, loading: !!p.loading })
}

// 电脑模式的 UA：本机 Chrome 自己的 UA 去掉 Headless 字样，client hints 跟着报桌面版 Chrome
let desktopUA = null
async function desktopIdentity() {
  if (desktopUA) return desktopUA
  const { userAgent, product } = await cdp('Browser.getVersion')
  const full = product.split('/')[1] || userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '0.0.0.0'
  const major = full.split('.')[0]
  const brands = [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not=A?Brand', version: '24' }]
  desktopUA = {
    userAgent: userAgent.replace('HeadlessChrome', 'Chrome'),
    platform: 'MacIntel',
    userAgentMetadata: {
      brands, fullVersionList: brands.map((b) => ({ ...b, version: b.brand === 'Not=A?Brand' ? ['24', 0, 0, 0].join('.') : full })),
      fullVersion: full, platform: 'macOS', platformVersion: '15.0.0', architecture: os.arch() === 'arm64' ? 'arm' : 'x86', model: '', mobile: false, bitness: '64',
    },
  }
  return desktopUA
}
async function applyUA(sessionId) {
  const ua = view.desktop ? await desktopIdentity() : { userAgent: IPHONE_UA, platform: 'iPhone' }
  await cdp('Network.setUserAgentOverride', ua, sessionId).catch(() => {})
}

async function attach(targetId) {
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
  const info = { sessionId, url: '', title: '', loading: false }
  pages.set(targetId, info)
  await cdp('Page.enable', {}, sessionId)
  await applyUA(sessionId)
  return info
}

function computePage() {
  if (!view.desktop) return { w: view.w, h: view.h, dpr: view.dpr }
  const w = DESKTOP_W
  const h = Math.max(600, Math.min(2000, Math.round(w * view.h / view.w)))
  // 截图倍率：够手机屏幕的物理像素就行（再放大看会糊一点，换流量），最少 1
  const fit = Math.min(view.w / w, view.h / h)
  const dpr = Math.max(1, Math.min(2, Math.round(fit * view.dpr * 1.15 * 100) / 100))
  return { w, h, dpr }
}

async function applyView(sessionId) {
  page = computePage()
  await cdp('Emulation.setDeviceMetricsOverride', { width: page.w, height: page.h, deviceScaleFactor: page.dpr, mobile: !view.desktop }, sessionId)
  await cdp('Emulation.setTouchEmulationEnabled', view.desktop ? { enabled: false } : { enabled: true, maxTouchPoints: 5 }, sessionId)
}

async function startCast(targetId) {
  const p = pages.get(targetId)
  if (!p) return
  await applyView(p.sessionId)
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }, p.sessionId)
  dirty = true
  pump()
}

async function focus(targetId) {
  if (current && current !== targetId && pages.has(current)) {
    await cdp('Page.stopScreencast', {}, pages.get(current).sessionId).catch(() => {})
  }
  current = targetId
  inflight = 0
  await cdp('Target.activateTarget', { targetId }).catch(() => {})
  await startCast(targetId)
  sendTabs()
  sendNav()
}

handlers.set('Page.screencastFrame', (params, sessionId) => {
  cdp('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})
  if (pages.get(current)?.sessionId !== sessionId) return
  dirty = true
  pump()
})

async function pump() {
  // 手机超过 5 秒没 ack（丢了），不再等
  if (inflight && Date.now() - inflightAt > 5000) inflight = 0
  if (inflight || capturing || !dirty || !current) return
  const p = pages.get(current)
  if (!p) return
  dirty = false
  capturing = true
  const fast = Date.now() - lastInput < FAST_MS
  try {
    // 截图偶尔会卡住不返回（页面切换、尺寸变化的瞬间）：2 秒超时，不然 capturing 永远是 true，再也不出画面
    // 显式给 clip：改了 setDeviceMetricsOverride 之后，不带 clip 的截图会一直按旧尺寸出图。
    // clip 的坐标是相对整个页面的，要加上当前滚动位置，不然页面一滚动就截到上面看不见的地方（一片空白）
    const lm = await cdp('Page.getLayoutMetrics', {}, p.sessionId).catch(() => null)
    const vv = lm?.cssVisualViewport
    const clip = { x: vv?.pageX || 0, y: vv?.pageY || 0, width: page.w, height: page.h, scale: fast ? 0.55 : 1 }
    const shot = await Promise.race([
      cdp('Page.captureScreenshot', { format: 'jpeg', quality: fast ? 45 : QUALITY, optimizeForSpeed: true, clip }, p.sessionId),
      sleep(2000).then(() => { throw new Error('capture timeout') }),
    ])
    seq++
    inflight = seq
    inflightAt = Date.now()
    out({ t: 'frame', seq, w: page.w, h: page.h, desktop: view.desktop, data: shot.data })
  } catch (e) {
    log('capture', e.message)
    dirty = true // 下一轮再试
  } finally {
    capturing = false
  }
}

setInterval(pump, 1000) // ack 丢了的兜底

function onAck(n) {
  if (n !== inflight) return
  inflight = 0
  pump()
}

handlers.set('Target.targetInfoChanged', ({ targetInfo }) => {
  const p = pages.get(targetInfo.targetId)
  if (!p) return
  p.url = targetInfo.url
  p.title = targetInfo.title
  if (targetInfo.targetId === current) sendNav()
  sendTabs()
})
handlers.set('Target.targetCreated', async ({ targetInfo }) => {
  if (targetInfo.type !== 'page' || pages.has(targetInfo.targetId)) return
  // 页面里 window.open / target=_blank 打开的新标签：直接切过去
  if (targetInfo.openerId) {
    try { await attach(targetInfo.targetId); await focus(targetInfo.targetId) } catch (e) { log('attach', e.message) }
  }
})
handlers.set('Target.targetDestroyed', async ({ targetId }) => {
  if (!pages.delete(targetId)) return
  if (targetId === current) {
    const next = [...pages.keys()].pop()
    if (next) await focus(next)
    else await newTab(HOME_URL)
  }
  sendTabs()
})
handlers.set('Page.frameStartedLoading', (_, sessionId) => setLoading(sessionId, true))
handlers.set('Page.frameStoppedLoading', (_, sessionId) => setLoading(sessionId, false))
function setLoading(sessionId, v) {
  for (const [id, p] of pages) if (p.sessionId === sessionId) { p.loading = v; if (id === current) sendNav() }
}

async function newTab(url) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  await attach(targetId)
  await focus(targetId)
  if (url && url !== 'about:blank') await navigate(url)
}

// 地址栏输入：本机路径 → 文件浏览器；localhost:3000 / 192.168.x.x → http://；像域名的补 https://；其余当搜索词
function normalizeUrl(input) {
  const s = input.trim()
  if (!s) return HOME_URL
  // 本机路径（~/… 、/… 、file://…）都交给文件浏览器：文件夹出列表，文件按类型显示，网页文件它再转回 file://
  if (/^file:\/\//i.test(s)) {
    try {
      const fp = decodeURIComponent(new URL(s).pathname)
      const real = resolveSafe(fp)
      return real && kindOf(real) === 'html' ? fileUrl(real) : viewUrl(fp) // 不在允许范围内的，交给文件浏览器去拒绝
    } catch { return HOME_URL }
  }
  if (/^(https?|about|data|chrome):/i.test(s)) return s
  if (s === '~' || s.startsWith('~/') || s.startsWith('/')) {
    const real = resolveSafe(s)
    return real && kindOf(real) === 'html' && fs.statSync(real).isFile() ? fileUrl(real) : viewUrl(s)
  }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|\[::1\])/i.test(s) || /^[\w.-]+:\d+(\/|$)/.test(s)) return 'http://' + s
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s)) return 'https://' + s
  return 'https://www.bing.com/search?q=' + encodeURIComponent(s)
}

async function navigate(url) {
  const p = pages.get(current)
  if (!p) return newTab(url)
  const res = await cdp('Page.navigate', { url: normalizeUrl(url) }, p.sessionId)
  if (res.errorText) out({ t: 'error', msg: `打不开：${res.errorText}` })
}

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Backspace: { code: 'Backspace', vk: 8 }, Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
}

const INPUTS = new Set(['tap', 'hover', 'scroll', 'text', 'key'])
async function handle(msg) {
  const p = pages.get(current)
  const sid = p?.sessionId
  if (INPUTS.has(msg.t)) touched()
  switch (msg.t) {
    case 'ack': return onAck(msg.seq)
    case 'refresh': inflight = 0; dirty = true; return pump() // 新手机连上：不管之前卡在哪，马上补一帧
    case 'viewport': {
      const next = { w: Math.max(200, Math.min(1600, Math.round(msg.w))), h: Math.max(200, Math.min(2000, Math.round(msg.h))), dpr: Math.max(1, Math.min(3, Number(msg.dpr) || 2)), desktop: !!msg.desktop }
      if (next.w === view.w && next.h === view.h && next.dpr === view.dpr && next.desktop === view.desktop) { inflight = 0; dirty = true; return pump() }
      const switched = next.desktop !== view.desktop
      view = next
      // 换模式：所有标签页换 UA，当前页重新加载（网站多半在服务端按 UA 出页面）
      if (switched) for (const p of pages.values()) await applyUA(p.sessionId)
      if (current) { await cdp('Page.stopScreencast', {}, sid).catch(() => {}); inflight = 0; await startCast(current) }
      if (switched && sid && p.url && p.url !== 'about:blank') await cdp('Page.reload', { ignoreCache: true }, sid).catch(() => {})
      return
    }
    case 'open': return navigate(msg.url)
    case 'new': return newTab(msg.url ? normalizeUrl(msg.url) : HOME_URL)
    case 'back': case 'forward': {
      const h = await cdp('Page.getNavigationHistory', {}, sid)
      const e = h.entries[h.currentIndex + (msg.t === 'back' ? -1 : 1)]
      if (e) await cdp('Page.navigateToHistoryEntry', { entryId: e.id }, sid)
      return
    }
    case 'reload': return cdp('Page.reload', {}, sid)
    case 'tap': {
      if (view.desktop) {
        const at = { x: msg.x, y: msg.y }
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, sid)
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }, sid)
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, sid)
        return
      }
      const pt = [{ x: msg.x, y: msg.y }]
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt }, sid)
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid)
      return
    }
    case 'hover': // 电脑模式长按：只把鼠标移过去（悬停菜单、提示）
      return cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: msg.x, y: msg.y }, sid)
    case 'scroll':
      return cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.dx || 0, deltaY: msg.dy || 0 }, sid)
    case 'text': return cdp('Input.insertText', { text: String(msg.s).slice(0, 4000) }, sid)
    case 'key': {
      const k = KEYS[msg.key]
      if (!k) return
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: msg.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, sid)
      if (k.text) await cdp('Input.dispatchKeyEvent', { type: 'char', key: msg.key, text: k.text }, sid)
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: msg.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, sid)
      return
    }
    case 'tabs': return sendTabs()
    case 'switch': if (pages.has(msg.id)) await focus(msg.id); return
    case 'close': if (pages.has(msg.id)) await cdp('Target.closeTarget', { targetId: msg.id }); return
  }
}

// ---------- 启动：接管已有标签页（上次留下的），没有就新开 ----------
await cdp('Target.setDiscoverTargets', { discover: true })
const { targetInfos } = await cdp('Target.getTargets')
for (const t of targetInfos.filter((t) => t.type === 'page')) {
  try { const p = await attach(t.targetId); p.url = t.url; p.title = t.title } catch (e) { log('attach', e.message) }
}
if (pages.size) await focus([...pages.keys()].pop())
else await newTab(HOME_URL)
out({ t: 'ready' })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  handle(msg).catch((e) => out({ t: 'error', msg: e.message }))
})
// 中转断开（stdin 关闭）：停掉推流、断开 CDP，Chrome 本身留着
rl.on('close', async () => {
  const p = pages.get(current)
  if (p) await cdp('Page.stopScreencast', {}, p.sessionId).catch(() => {})
  ws.close()
  process.exit(0)
})
