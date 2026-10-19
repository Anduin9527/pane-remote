// 唤出一个 app 的窗口（bridge 的 screen-summon）：
//   Spotlight：按系统设置里它的快捷键；uTools：按它自己设置里的唤出快捷键（记在 settings 的 showHotKey，比如 Alt+Space）
//   别的：先像点程序坞图标那样重新打开；1.2 秒还没窗口、又是托盘 app，就点一下它的菜单栏图标
// 全靠 mousectl 发事件；输出 ok 或 error: …
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
const SOCK = process.env.VNC_PROXY_MOUSECTL || path.join(process.env.HOME, '.cache/pane-remote/mouse.sock')
const id = process.argv[2] || ''
if (!/^[A-Za-z0-9.-]{1,200}$/.test(id)) { console.log('error: bad bundle id'); process.exit(2) }
function ask(cmd) {
  return new Promise((res) => {
    const c = net.connect(SOCK, () => c.write(cmd + '\n'))
    let buf = ''
    const done = (v) => { clearTimeout(t); c.destroy(); res(v) }
    const t = setTimeout(() => done(''), 8000)
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) done(buf.slice(0, i)) })
    c.on('error', (e) => done('error: mousectl ' + e.code))
  })
}
const send = (lines) => new Promise((res) => { const c = net.connect(SOCK, () => { c.write(lines.join('\n') + '\n'); setTimeout(() => { c.end(); res() }, 200) }); c.on('error', () => res()) })
// 「Alt+Space」「Command+Shift+U」这类写法 → macOS 键码 + 修饰键标志
const MODS = { alt: [58, 0x80000], option: [58, 0x80000], command: [55, 0x100000], cmd: [55, 0x100000], ctrl: [59, 0x40000], control: [59, 0x40000], shift: [56, 0x20000] }
const KEYS = { space: 49, enter: 36, return: 36, tab: 48, escape: 53, esc: 53, up: 126, down: 125, left: 123, right: 124, ...Object.fromEntries([...'asdfhgzxcv'].map((c, i) => [c, i])), b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 }
function hotkeyLines(spec) {
  const parts = spec.split('+').map((x) => x.trim().toLowerCase())
  const key = KEYS[parts.pop()]
  const mods = parts.map((m) => MODS[m])
  if (key == null || mods.some((m) => !m)) return null
  const flags = mods.reduce((f, m) => f | m[1], 0)
  const fn = key >= 123 && key <= 126 ? 0xa00000 : [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].includes(key) ? 0x800000 : 0
  let f = 0
  const lines = []
  for (const m of mods) { f |= m[1]; lines.push(`k ${m[0]} ${f} 1`) }
  lines.push(`k ${key} ${flags | fn} 1`, `k ${key} ${flags | fn} 0`)
  for (const m of [...mods].reverse()) { f &= ~m[1]; lines.push(`k ${m[0]} ${f} 0`) }
  return lines
}
// Spotlight：系统设置里「显示聚焦搜索」的快捷键（symbolichotkeys 第 64 项：[字符, 键码, 修饰键标志]），默认 ⌘ 空格
if (id === 'com.apple.Spotlight') {
  let key = 49, flags = 0x100000
  try {
    const { execFileSync } = await import('node:child_process')
    const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(process.env.HOME, 'Library/Preferences/com.apple.symbolichotkeys.plist')], { encoding: 'utf8' }))
    const h = j.AppleSymbolicHotKeys?.['64']
    if (h?.enabled && h.value?.parameters) { key = h.value.parameters[1]; flags = h.value.parameters[2] }
  } catch {}
  const mods = Object.values({ cmd: [55, 0x100000], opt: [58, 0x80000], ctrl: [59, 0x40000], shift: [56, 0x20000] }).filter(([, f]) => flags & f)
  let f = 0
  const lines = []
  for (const m of mods) { f |= m[1]; lines.push(`k ${m[0]} ${f} 1`) }
  lines.push(`k ${key} ${flags} 1`, `k ${key} ${flags} 0`)
  for (const m of [...mods].reverse()) { f &= ~m[1]; lines.push(`k ${m[0]} ${f} 0`) }
  await send(lines)
  console.log('ok')
  process.exit(0)
}
if (id === 'org.yuanli.utools') {
  let spec = 'Alt+Space'
  try { spec = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'Library/Application Support/uTools/settings'), 'utf8')).showHotKey || spec } catch {}
  const lines = hotkeyLines(spec)
  if (!lines) { console.log(`error: 看不懂 uTools 的唤出快捷键 ${spec}`); process.exit(1) }
  await send(lines)
  console.log('ok')
  process.exit(0)
}
const r = await ask(`w launch ${id}`)
if (r !== 'ok') { console.log(r || 'error: launch failed'); process.exit(1) }
await new Promise((res) => setTimeout(res, 1200))
let has = false
try { has = JSON.parse(await ask('w list')).windows.some((w) => w.bundle === id && w.onScreen) } catch {}
if (!has) {
  let apps = []
  try { apps = JSON.parse(await ask('w apps')).apps || [] } catch {}
  if (apps.find((a) => a.bundle === id)?.tray) { console.log(await ask(`w tray ${id}`)); process.exit(0) }
}
console.log('ok')
