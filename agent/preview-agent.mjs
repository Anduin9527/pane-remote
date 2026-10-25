// 手机预览：在电脑上控制一个独立的无界面 Chrome（单独的用户目录，cookie / 登录和日常 Chrome 隔开），
// 网络完全走这台电脑（localhost、内网、系统代理都照用）。由 bridge 的 preview 命令启动，
// stdin / stdout 是和中转服务器之间的通道，每行一个 JSON。
//
// 收（中转 → 这里）：open{url} viewport{w,h,dpr,desktop,lang} tap{x,y} hover{x,y} scroll{x,y,dy} text{s} key{key}
//                   back forward reload ack{seq} tabs switch{id} close{id} new{url} save
// 发（这里 → 中转）：frame{seq,w,h,data(base64 jpeg)} nav{url,title,loading} tabs{list,current} download{id,name,size} error{msg} ready
//
// 出图：无界面 Chrome 的 screencast 只按 CSS 像素出图（手机上发糊），所以 screencast 只当「画面变了」的门铃
// （最小尺寸、最低画质），真正的帧用 captureScreenshot 按手机像素密度截。
// 流控：同一时间只有一帧在路上，手机画完 ack 了才截下一张；中间画面变了多少次都合并成一张最新的，
// 帧率自动跟着手机那头的网速走，网络慢不会积压。
// 电脑模式（viewport.desktop）：UA / client hints 换成桌面版 Chrome，按 DESKTOP_W 宽的桌面窗口渲染（高度按手机画面比例），
// 关掉触屏模拟，轻点发鼠标点击；手机那头缩放显示。帧里的 w / h 都是页面的 CSS 尺寸，手机按它换算坐标。
//
// node preview-agent.mjs --stop  关掉预览用的 Chrome
// node preview-agent.mjs --get <id>  输出一个登记过的下载（给手机取文件用）
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

// PREVIEW_SOURCE=cursor：不开自己的 Chrome，而是接管 Cursor IDE 内置浏览器（Cursor 调试端口里 type=webview 的目标）。
// 那是用户在电脑上也看着的面板：绝不改它的尺寸 / UA / 触摸模拟，不新开、不关闭标签，--stop 什么都不做
const CURSOR = process.env.PREVIEW_SOURCE === 'cursor'
const CURSOR_PORT = Number(process.env.CURSOR_DEBUG_PORT || 9333)
const TARGET_TYPE = CURSOR ? 'webview' : 'page'
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

// ---------- 下载到手机 ----------
// 网页里触发的下载、手机上点「保存当前页」都登记在 downloads/<id>.json（文件路径和文件名），手机凭 id 经服务端取文件。
// Chrome 下载的文件也放在 downloads/ 里，一天后连同登记一起清掉；登记的是本机原文件时只删登记
const DL_DIR = path.join(DIR, 'downloads')
const DL_KEEP_MS = 24 * 3600e3
// node preview-agent.mjs --get <id>：第一行 JSON（name、size），后面是文件内容。bridge 的 preview-get 调它
if (process.argv[2] === '--get') {
  try {
    const id = process.argv[3] || ''
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('bad id')
    const meta = JSON.parse(fs.readFileSync(path.join(DL_DIR, `${id}.json`), 'utf8'))
    const real = fs.realpathSync(meta.path)
    const home = os.homedir()
    const own = (() => { try { return fs.realpathSync(DL_DIR) + '/' } catch { return DL_DIR + '/' } })()
    if (!(real.startsWith(own) || real.startsWith(home + '/') || /^\/(private\/)?tmp\//.test(real))) throw new Error('bad path')
    const st = fs.statSync(real)
    if (!st.isFile()) throw new Error('not a file')
    process.stdout.write(JSON.stringify({ name: meta.name, size: st.size }) + '\n')
    const { pipeline } = await import('node:stream/promises')
    await pipeline(fs.createReadStream(real), process.stdout)
    process.exit(0)
  } catch (e) {
    process.stderr.write(`error: ${e.code === 'ENOENT' ? '文件已经过期或被删掉了' : e.message}\n`)
    process.exit(1)
  }
}

if (process.argv.includes('--stop') && CURSOR) { console.log('cursor source: nothing to stop'); process.exit(0) }
if (process.argv.includes('--stop')) {
  const pid = stopChrome()
  console.log(pid ? `stopped ${pid}` : 'not running')
  process.exit(0)
}

// Chrome 退出后 DevToolsActivePort 可能还留着，所以先确认进程在
async function browserWsUrl() {
  if (CURSOR) {
    try { return (await (await fetch(`http://127.0.0.1:${CURSOR_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).json()).webSocketDebuggerUrl }
    catch { throw new Error('Cursor 没有接入（没开调试端口）：先在手机的 Cursor 页面启动 / 重启接入') }
  }
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
ws.onclose = () => { out({ t: 'error', msg: CURSOR ? '和 Cursor 的连接断了（Cursor 关了或重启了）' : '和 Chrome 的连接断了' }); process.exit(1) }

// ---------- 文件浏览器：给预览里的 Chrome 看电脑上的文件夹和各种文件 ----------
// 只监听 127.0.0.1，路径前面带随机令牌：别的网页猜不到地址，读不到文件。只允许家目录和 /tmp。
// /<令牌>/view?p=路径  文件夹 → 列表；文件 → 按类型显示（图片 / 视频 / 音频 / PDF / Markdown / 代码文本 / CSV）
// /<令牌>/raw?p=路径   原始文件（支持 Range，视频能拖进度）
// 令牌和端口存下来，重启后沿用：Chrome 是常驻的，开着的标签页、后退记录里都是旧地址，换了就全打不开（连接一断代理就会重启）。
// 每个来源一份（chrome / cursor 两个代理同时跑），文件只有自己能读
const FILES_STATE = path.join(DIR, `files-${CURSOR ? 'cursor' : 'chrome'}.json`)
const saved = (() => { try { const o = JSON.parse(fs.readFileSync(FILES_STATE, 'utf8')); return /^[0-9a-f]{32}$/.test(o.token) ? o : null } catch { return null } })()
const TOKEN = saved?.token || crypto.randomUUID().replaceAll('-', '')
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
// 文件浏览器页面的界面语言：手机在 viewport 里带 lang（只认 'en' / 'zh'，默认中文），页面按它出中文或英文
let uiLang = 'zh'
const PAGE_EN = {
  '打不开': 'Cannot open',
  '上一级': 'Up one level',
  '显示 {n} 个隐藏项': 'Show {n} hidden',
  '不显示 {n} 个隐藏项': 'Hide {n} hidden',
  '{d} 个文件夹 · {f} 个文件': '{d} folders · {f} files',
  '（只列前 {n} 个）': ' (showing first {n})',
  '空文件夹': 'Empty folder',
  '所在文件夹': 'Enclosing folder',
  '加载中…': 'Loading…',
  '{n} 页': '{n} pages',
  '类型': 'Type',
  '{ext} 文件（预览不了，不是文本）': '{ext} file (no preview, not text)',
  '大小': 'Size',
  '修改时间': 'Modified',
  '位置': 'Location',
  '文件有 {size}，只显示前 2 MB': 'File is {size}; showing the first 2 MB only',
  '{n} 行': '{n} rows',
  '正在打开网页文件…': 'Opening HTML file…',
  '只能看家目录和 /tmp 里的文件，或者文件不存在': 'Only files in your home folder and /tmp can be viewed, or the file does not exist',
  '下载': 'Download',
}
/** 页面文案：中文原文当 key，英文模式查表；{x} 占位按 vars 填 */
const L = (zh, vars) => {
  const s = uiLang === 'en' ? PAGE_EN[zh] ?? zh : zh
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s
}
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
  u = fixStale(u) || u
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
  `<!doctype html><html lang="${uiLang === 'en' ? 'en' : 'zh'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style>${head}</head><body><header>${crumbs(p)}<div class="meta">${meta}</div></header>${body}</body></html>`

function icon(name, dir) {
  if (dir) return '📁'
  const k = kindOf(name), e = extOf(name)
  return { image: '🖼️', video: '🎬', audio: '🎵', md: '📝', csv: '📊', html: '🌐', pdf: '📕' }[k] || (LANG[e] || ['txt', 'log'].includes(e) ? '📄' : ['zip', 'gz', 'tgz', 'rar', '7z', 'dmg', 'tar'].includes(e) ? '📦' : '📎')
}

function dirPage(p, showHidden) {
  let list = []
  try { list = fs.readdirSync(p, { withFileTypes: true }) } catch (e) { return htmlPage(path.basename(p), p, esc(L('打不开')), `<p class="empty">${esc(e.message)}</p>`) }
  const hidden = list.filter((e) => e.name.startsWith('.')).length
  if (!showHidden) list = list.filter((e) => !e.name.startsWith('.'))
  const rows = list.map((e) => {
    const full = path.join(p, e.name)
    let st = null
    try { st = fs.statSync(full) } catch {}
    return { name: e.name, full, dir: !!st?.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 }
  }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh', { numeric: true }) : a.dir ? -1 : 1))
  const shown = rows.slice(0, 2000)
  const up = p !== '/' && resolveSafe(path.dirname(p)) ? `<a class="row" href="${esc(viewUrl(path.dirname(p)))}"><span class="ic">⬆️</span><span class="nm"><b>${esc(L('上一级'))}</b></span></a>` : ''
  const html = shown.map((r) => {
    const thumb = !r.dir && kindOf(r.name) === 'image' && r.size < 30 * 1048576 ? `<img loading="lazy" src="${esc(rawUrl(r.full))}">` : icon(r.name, r.dir)
    const sub = r.dir ? fmtTime(r.mtime) : `${fmtSize(r.size)} · ${fmtTime(r.mtime)}`
    return `<a class="row" href="${esc(viewUrl(r.full))}"><span class="ic">${thumb}</span><span class="nm"><b>${esc(r.name)}</b><small>${sub}</small></span></a>`
  }).join('')
  const dirs = rows.filter((r) => r.dir).length
  const toggle = hidden ? ` · <a href="${esc(viewUrl(p) + (showHidden ? '' : '&hidden=1'))}">${esc(L(showHidden ? '不显示 {n} 个隐藏项' : '显示 {n} 个隐藏项', { n: hidden }))}</a>` : ''
  const meta = `${esc(L('{d} 个文件夹 · {f} 个文件', { d: dirs, f: rows.length - dirs }))}${rows.length > shown.length ? esc(L('（只列前 {n} 个）', { n: shown.length })) : ''}${toggle}`
  return htmlPage(path.basename(p) || '/', p, meta, up + (html || `<p class="empty">${esc(L('空文件夹'))}</p>`))
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
  let meta = `${fmtSize(st.size)} · ${fmtTime(st.mtimeMs)} · <a href="${esc(viewUrl(path.dirname(p)))}">${esc(L('所在文件夹'))}</a>`
  const raw = esc(rawUrl(p))
  meta += ` · <a href="${esc(rawUrl(p) + '&dl=1')}">${esc(L('下载'))}</a>`
  if (k === 'image') return htmlPage(name, p, meta, `<main class="media"><img src="${raw}"></main>`)
  if (k === 'video') return htmlPage(name, p, meta, `<main class="media"><video src="${raw}" controls playsinline preload="metadata"></video></main>`)
  if (k === 'audio') return htmlPage(name, p, meta, `<main><audio src="${raw}" controls preload="metadata" style="width:100%"></audio></main>`)
  if (k === 'pdf') {
    return htmlPage(name, p, meta + ` · <span id="pg">${esc(L('加载中…'))}</span>`, `<main class="pdf" id="pdf"></main>${dataBlock({ raw: rawUrl(p), lib: vendorUrl('pdf.mjs'), worker: vendorUrl('pdf.worker.mjs'), pages: L('{n} 页') })}`, `<script type="module" nonce="${NONCE}">
const d = JSON.parse(document.getElementById('data').textContent)
const pdfjs = await import(d.lib)
pdfjs.GlobalWorkerOptions.workerSrc = d.worker
const doc = await pdfjs.getDocument(d.raw).promise
const box = document.getElementById('pdf'); document.getElementById('pg').textContent = d.pages.replace('{n}', doc.numPages)
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
    return htmlPage(name, p, meta, `<div class="card"><b>${esc(name)}</b><dl><dt>${esc(L('类型'))}</dt><dd>${esc(L('{ext} 文件（预览不了，不是文本）', { ext: e.toUpperCase() }))}</dd><dt>${esc(L('大小'))}</dt><dd>${fmtSize(st.size)}</dd><dt>${esc(L('修改时间'))}</dt><dd>${fmtTime(st.mtimeMs)}</dd><dt>${esc(L('位置'))}</dt><dd>${esc(tilde(p))}</dd></dl></div>`)
  }
  const text = head.toString('utf8')
  const cut = st.size > MAX ? `<p class="note">${esc(L('文件有 {size}，只显示前 2 MB', { size: fmtSize(st.size) }))}</p>` : ''
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
    return htmlPage(name, p, `${meta} · ${esc(L('{n} 行', { n: body.length + (rows.length >= 2000 ? '+' : '') }))}`, `${cut}<div style="overflow:auto">${table}</div>`)
  }
  let lang = LANG[e] || LANG[name.toLowerCase()] || ''
  let shown = text
  if (e === 'json' && st.size <= MAX) { try { shown = JSON.stringify(JSON.parse(text), null, 2) } catch {} }
  // 太大的文本不高亮（几十万字符时 highlight.js 会卡住页面）
  const hl = lang && shown.length <= 400000 ? `${vcss('hljs.css')}${vscript('hljs.js')}<script nonce="${NONCE}">addEventListener('DOMContentLoaded', () => { try { hljs.highlightElement(document.querySelector('pre code')) } catch {} })</script>` : ''
  return htmlPage(name, p, meta, `${cut}<pre><code class="${lang ? 'language-' + lang : ''}">${esc(shown)}</code></pre>`, hl)
}

function sendRaw(req, res, p, download = false) {
  const st = fs.statSync(p)
  const type = MIME[extOf(p)] || 'application/octet-stream'
  // ?dl=1：当附件给出，Chrome 走下载（下载完由 Browser.downloadProgress 转给手机）
  const disp = download ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` } : {}
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]))
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
    if (start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end() }
    res.writeHead(206, { ...RAW_HEADERS, ...disp, 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' })
    return fs.createReadStream(p, { start, end }).pipe(res)
  }
  res.writeHead(200, { ...RAW_HEADERS, ...disp, 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' })
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
  if (!p) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(L('只能看家目录和 /tmp 里的文件，或者文件不存在')) }
  try {
    if (route === 'raw') return sendRaw(req, res, p, u.searchParams.get('dl') === '1')
    if (route !== 'view') { res.writeHead(404); return res.end() }
    const isDir = fs.statSync(p).isDirectory()
    // 网页文件要用 file:// 打开（相对路径的图片、脚本才找得到，也照 Chrome 本地文件的规矩不能读别的文件）。
    // http 页面不能跳到 file://（重定向、链接都会被拦），所以由这边用 DevTools 让当前标签页直接打开
    if (!isDir && kindOf(p) === 'html') {
      const sid = pages.get(current)?.sessionId
      if (sid) setTimeout(() => cdp('Page.navigate', { url: fileUrl(p) }, sid).catch(() => {}), 0)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(`<meta charset="utf-8">${esc(L('正在打开网页文件…'))}`)
    }
    NONCE = crypto.randomBytes(16).toString('base64')
    const html = isDir ? dirPage(p, u.searchParams.has('hidden')) : filePage(p)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': pageCsp(), 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(html)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(e.message)
  }
})
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const fail = (e) => { fileServer.off('listening', ok); reject(e) }
    const ok = () => { fileServer.off('error', fail); resolve() }
    fileServer.once('error', fail).once('listening', ok).listen(port, '127.0.0.1')
  })
}
// 上次的端口被占了（比如旧代理还没退）就随便换一个，旧地址靠下面的 fixStale 改过来
try { if (!saved?.port) throw 0; await listenOn(saved.port) } catch { await listenOn(0) }
filesBase = `http://127.0.0.1:${fileServer.address().port}/${TOKEN}`
try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILES_STATE, JSON.stringify({ token: TOKEN, port: fileServer.address().port }), { mode: 0o600 }) } catch (e) { log('files state', e.message) }
/** 以前的代理留下的文件浏览器地址（端口或令牌不一样了）→ 换成现在的；不是就返回 null */
function fixStale(u) {
  const m = /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}(\/(?:view|raw)\?.*)$/.exec(u || '')
  return m && !u.startsWith(filesBase + '/') ? filesBase + m[1] : null
}

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
  if (!CURSOR) await applyUA(sessionId)
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

// Cursor 的内置浏览器：尺寸由 Cursor 的面板决定，只读不改；截图按手机屏幕需要的像素缩小
let cursorDpr = 0
async function cursorPage(sessionId) {
  const lm = await cdp('Page.getLayoutMetrics', {}, sessionId).catch(() => null)
  const w = lm?.cssLayoutViewport?.clientWidth || 1000, h = lm?.cssLayoutViewport?.clientHeight || 800
  if (!cursorDpr) cursorDpr = (await cdp('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true }, sessionId).catch(() => null))?.result?.value || 2
  const want = view.w * view.dpr * 1.15 // 手机上需要的像素宽度
  return { w, h, dpr: cursorDpr, scale: Math.max(0.3, Math.min(1, want / (w * cursorDpr))) }
}
async function applyView(sessionId) {
  if (CURSOR) { page = await cursorPage(sessionId); return }
  page = computePage()
  await cdp('Emulation.setDeviceMetricsOverride', { width: page.w, height: page.h, deviceScaleFactor: page.dpr, mobile: !view.desktop }, sessionId)
  await cdp('Emulation.setTouchEmulationEnabled', view.desktop ? { enabled: false } : { enabled: true, maxTouchPoints: 5 }, sessionId)
}

async function startCast(targetId) {
  const p = pages.get(targetId)
  if (!p) return
  await applyView(p.sessionId)
  // 两条消息（连着两次换尺寸、重复切到同一页）并发时会 stop、stop、start、start：后一次 start 报「已经在推流」，推流其实正常，不算错
  await cdp('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }, p.sessionId)
    .catch((e) => { if (!/already active/i.test(e.message)) throw e })
  dirty = true
  pump()
}

async function focus(targetId) {
  if (current && current !== targetId && pages.has(current)) {
    await cdp('Page.stopScreencast', {}, pages.get(current).sessionId).catch(() => {})
  }
  current = targetId
  inflight = 0
  // Cursor 那边不激活：会把 Cursor 窗口拉到电脑屏幕最前面，抢走用户正在用的窗口
  if (!CURSOR) await cdp('Target.activateTarget', { targetId }).catch(() => {})
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
    // Cursor 的面板可能被用户在电脑上拖大拖小：每帧按当前尺寸截
    if (CURSOR && lm?.cssLayoutViewport) { page.w = lm.cssLayoutViewport.clientWidth; page.h = lm.cssLayoutViewport.clientHeight }
    const clip = { x: vv?.pageX || 0, y: vv?.pageY || 0, width: page.w, height: page.h, scale: (fast ? 0.55 : 1) * (page.scale || 1) }
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
  // 刷新、后退、页面里的链接走到了旧代理的地址：直接改去现在的
  const fixed = fixStale(p.url)
  if (fixed) { cdp('Page.navigate', { url: fixed }, p.sessionId).catch(() => {}); return }
  if (targetInfo.targetId === current) sendNav()
  sendTabs()
})
handlers.set('Target.targetCreated', async ({ targetInfo }) => {
  if (targetInfo.type !== TARGET_TYPE || pages.has(targetInfo.targetId)) return
  // Cursor 里新打开了网页：接过来并切过去
  if (CURSOR) { try { await attach(targetInfo.targetId); await focus(targetInfo.targetId); out({ t: 'notice', msg: 'Cursor 的浏览器打开了网页' }) } catch (e) { log('attach', e.message) } return }
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
    else if (CURSOR) { current = null; out({ t: 'nav', url: '', title: '', loading: false }); out({ t: 'error', msg: 'Cursor 的浏览器关掉了；在 Cursor 里再打开网页，这里会自动接上' }) }
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
  if (CURSOR) throw new Error('Cursor 的浏览器不能从手机新开标签，请在 Cursor 的 Browser 面板里打开')
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
  if (/^(https?|about|data|chrome):/i.test(s)) return fixStale(s) || s
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
  const target = normalizeUrl(url)
  const res = await cdp('Page.navigate', { url: target }, p.sessionId)
  // 网址是个下载（附件、zip 之类）：导航会以 ERR_ABORTED 结束，文件由下面的下载事件处理，不算打不开
  if (res.errorText && !/ERR_ABORTED/.test(res.errorText)) out({ t: 'error', user: true, msg: navError(target, res.errorText) })
}
// 网址本身打不开（本机开发服务器没起、域名错了）是用户这边的事，不是 pane-remote 的故障：带上地址说清楚，手机上不当故障上报（user: true）
function navError(target, err) {
  let host = target
  try { host = new URL(target).host || target } catch {} // ignore: 不是合法网址就原样显示
  const local = /^(localhost|127\.|\[::1\])/i.test(host)
  return `打不开 ${host}：${local && /CONNECTION_REFUSED/.test(err) ? `${host} 上没有服务在跑，开发服务器启动了吗？` : err}`
}

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Backspace: { code: 'Backspace', vk: 8 }, Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
  Delete: { code: 'Delete', vk: 46 }, Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 }, ' ': { code: 'Space', vk: 32, text: ' ' },
}
// 单个字符（手机上点了 ⌘ 再打 c 这类）
function keyDef(key) {
  if (KEYS[key]) return KEYS[key]
  if (typeof key !== 'string' || [...key].length !== 1) return null
  const up = key.toUpperCase()
  if (/^[A-Z]$/.test(up)) return { code: `Key${up}`, vk: up.charCodeAt(0), text: key }
  if (/^\d$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0), text: key }
  return { code: '', vk: 0, text: key }
}
const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
// macOS 上的 Chrome：模拟的 ⌘ 组合键不会触发编辑命令（全选、复制、粘贴…），要用 commands 直接告诉它
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' }
function editCommands(key, mods) {
  if (process.platform !== 'darwin' || !mods.includes('Meta') || mods.includes('Control') || mods.includes('Alt')) return undefined
  const k = String(key).toLowerCase()
  if (k === 'z' && mods.includes('Shift')) return ['redo']
  return MAC_COMMANDS[k] && !mods.includes('Shift') ? [MAC_COMMANDS[k]] : undefined
}

// 手机的界面语言变了：当前标签页是文件浏览器的页面就重新加载，换成新语言
function setUiLang(l) {
  if (l === uiLang) return
  uiLang = l
  const p = pages.get(current)
  if (p && filesBase && p.url.startsWith(filesBase + '/')) cdp('Page.reload', {}, p.sessionId).catch(() => {})
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
      if (msg.lang === 'en' || msg.lang === 'zh') setUiLang(msg.lang)
      const next = { w: Math.max(200, Math.min(1600, Math.round(msg.w))), h: Math.max(200, Math.min(2000, Math.round(msg.h))), dpr: Math.max(1, Math.min(3, Number(msg.dpr) || 2)), desktop: CURSOR || !!msg.desktop }
      if (CURSOR) { view = next; if (current) { page = await cursorPage(sid); inflight = 0; dirty = true; pump() } return }
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
      const k = keyDef(msg.key)
      if (!k) return
      const mods = Array.isArray(msg.mods) ? msg.mods.filter((m) => MOD_BIT[m]) : []
      const modifiers = mods.reduce((a, m) => a | MOD_BIT[m], 0)
      const base = { key: msg.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers }
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, commands: editCommands(msg.key, mods) }, sid)
      // 带 ⌘ / ⌃ 的是快捷键，不输入字符
      if (k.text && !(modifiers & (MOD_BIT.Meta | MOD_BIT.Control))) await cdp('Input.dispatchKeyEvent', { type: 'char', key: msg.key, text: k.text, modifiers }, sid)
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid)
      return
    }
    case 'save': return saveCurrent()
    case 'tabs': return sendTabs()
    case 'switch': if (pages.has(msg.id)) await focus(msg.id); return
    case 'close': if (CURSOR) throw new Error('Cursor 的浏览器标签请在 Cursor 里关'); if (pages.has(msg.id)) await cdp('Target.closeTarget', { targetId: msg.id }); return
  }
}

// ---------- 下载到手机 ----------
const dlName = (s) => String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120) || 'download'
/** 登记一个可以给手机取的文件，告诉手机 */
function offer(file, name) {
  const id = crypto.randomBytes(16).toString('hex')
  const size = fs.statSync(file).size
  fs.writeFileSync(path.join(DL_DIR, `${id}.json`), JSON.stringify({ path: file, name: dlName(name), at: Date.now() }), { mode: 0o600 })
  out({ t: 'download', id, name: dlName(name), size })
}
function pruneDownloads() {
  let list = []
  try { list = fs.readdirSync(DL_DIR) } catch { return }
  const now = Date.now()
  for (const f of list) {
    const full = path.join(DL_DIR, f)
    try {
      if (now - fs.statSync(full).mtimeMs < DL_KEEP_MS) continue
      fs.rmSync(full, { force: true }) // 登记、Chrome 下载的文件、存下来的 PDF 都在这个目录里；登记指向的本机原文件不在这里，不会删
    } catch {} // ignore: 清不掉下次再清
  }
}
fs.mkdirSync(DL_DIR, { recursive: true })
pruneDownloads()
setInterval(pruneDownloads, 3600e3).unref()

// 网页里的下载：Chrome 存进 downloads/（文件名用 guid），下完登记给手机。Cursor 的浏览器是用户自己的，不改它的下载设置
const downloading = new Map() // guid → 建议的文件名
if (!CURSOR) {
  await cdp('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL_DIR, eventsEnabled: true }).catch((e) => log('downloads', e.message))
  handlers.set('Browser.downloadWillBegin', ({ guid, suggestedFilename }) => {
    downloading.set(guid, suggestedFilename)
    out({ t: 'notice', msg: `正在下载 ${dlName(suggestedFilename)}…` })
  })
  handlers.set('Browser.downloadProgress', ({ guid, state }) => {
    if (state === 'inProgress' || !downloading.has(guid)) return
    const name = downloading.get(guid)
    downloading.delete(guid)
    if (state === 'completed') { try { offer(path.join(DL_DIR, guid), name) } catch (e) { out({ t: 'error', msg: `下载的文件找不到了：${e.message}` }) } }
    else out({ t: 'error', user: true, msg: `下载取消了：${dlName(name)}` })
  })
}

// 「保存当前页」：本机文件（文件浏览器里打开的、file:// 网页）给原文件；普通网页存成 PDF
async function saveCurrent() {
  const p = pages.get(current)
  if (!p) throw new Error('没有打开的网页')
  const u = fixStale(p.url) || p.url
  let local = null
  try {
    if (filesBase && u.startsWith(filesBase + '/')) local = resolveSafe(new URL(u).searchParams.get('p'))
    else if (/^file:\/\//i.test(u)) local = resolveSafe(decodeURIComponent(new URL(u).pathname))
  } catch {} // ignore: 地址解析不了就按普通网页处理
  if (local) {
    if (fs.statSync(local).isDirectory()) throw new Error('这是文件夹：打开里面的文件再保存')
    return offer(local, path.basename(local))
  }
  if (!/^https?:/i.test(u)) throw new Error('这个页面不能保存')
  out({ t: 'notice', msg: '正在把网页存成 PDF…' })
  const { data } = await cdp('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, p.sessionId)
  const file = path.join(DL_DIR, `${crypto.randomUUID()}.pdf`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  let host = ''
  try { host = new URL(u).host } catch {} // ignore
  const title = (await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, p.sessionId).catch(() => null))?.result?.value || p.title
  offer(file, `${dlName(title || host).replace(/\.pdf$/i, '')}.pdf`)
}

// ---------- 启动：接管已有标签页（上次留下的），没有就新开 ----------
await cdp('Target.setDiscoverTargets', { discover: true })
const { targetInfos } = await cdp('Target.getTargets')
for (const t of targetInfos.filter((t) => t.type === TARGET_TYPE)) {
  try {
    const p = await attach(t.targetId); p.url = t.url; p.title = t.title
    const fixed = fixStale(t.url) // 上一个代理打开的文件浏览器页面
    if (fixed) cdp('Page.navigate', { url: fixed }, p.sessionId).catch(() => {})
  } catch (e) { log('attach', e.message) }
}
if (pages.size) await focus([...pages.keys()].pop())
else if (CURSOR) out({ t: 'error', msg: 'Cursor 的浏览器现在没打开网页：在 Cursor 里打开 Browser 面板访问一个网址，这里会自动接上' })
else await newTab(HOME_URL)
if (CURSOR) view.desktop = true // 点击一律走鼠标事件
// Cursor 新打开浏览器时不一定发 targetCreated：没接上页面时每 2 秒查一次目标列表兜底
if (CURSOR) setInterval(async () => {
  if (current) return
  try {
    const { targetInfos: list } = await cdp('Target.getTargets')
    const t = list.find((x) => x.type === 'webview' && !pages.has(x.targetId))
    if (t) { const p = await attach(t.targetId); p.url = t.url; p.title = t.title; await focus(t.targetId); out({ t: 'notice', msg: 'Cursor 的浏览器打开了网页' }) }
  } catch (e) { log('poll', e.message) }
}, 2000)
out({ t: 'ready', source: CURSOR ? 'cursor' : 'chrome' })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  enqueue(msg)
})
// 消息一条处理完再处理下一条：以前并发处理，连着两次换尺寸会 stop、stop、start、start，打字和按键也可能交错。
// ack / refresh 只是放行出图，不用排队。一条最多等 10 秒（比如打开一个一直不响应的网址），免得把后面的全堵住
let queue = Promise.resolve()
function enqueue(msg) {
  const run = () => handle(msg).catch((e) => out({ t: 'error', msg: e.message }))
  if (msg.t === 'ack' || msg.t === 'refresh') return run()
  queue = queue.then(() => Promise.race([run(), sleep(10000)]))
}
// 中转断开（stdin 关闭）：停掉推流、断开 CDP，Chrome 本身留着
rl.on('close', async () => {
  const p = pages.get(current)
  if (p) await cdp('Page.stopScreencast', {}, p.sessionId).catch(() => {})
  ws.close()
  process.exit(0)
})
