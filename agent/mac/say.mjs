// 让电脑用 macOS 自带的 say 念一段话（mac 模块，bridge 的 mac-voices / mac-say / mac-say-stop）。
//   voices             JSON：可用的嗓音（中文排前面，同名的去重）
//   say <base64 JSON>  {text, voice, rate, volume}：后台开始念，马上返回；volume = 念的时候临时用的音量 0–100（念完调回去），不给就不动
//   stop               停掉正在念的（临时改过的音量也调回去）
// 文字、嗓音都作为参数直接交给 say（不经过 shell，文字放在 -- 后面）；嗓音必须是系统列表里有的
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const STATE = process.env.PANE_REMOTE_SAY_STATE || path.join(process.env.HOME, '.cache/pane-remote/say.json')
const SAY = process.env.PANE_REMOTE_SAY_BIN || '/usr/bin/say' // 测试时指到假的 say
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }) } catch { return '' } }
function voices() {
  // 同一个名字会出现两次（普通版和增强版），去重
  const seen = new Set()
  return run(SAY, ['-v', '?']).split('\n').map((l) => /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#\s*(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), lang: m[2], sample: m[3] }))
    .filter((v) => !seen.has(v.name) && seen.add(v.name))
}
const setVolume = (v) => run('/usr/bin/osascript', ['-e', `set volume output volume ${Math.max(0, Math.min(100, Math.round(Number(v))))}`])
function stop() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    // 只杀自己记下的那个 say（确认进程名，免得 pid 被别的进程复用）
    if (Number.isInteger(s.pid) && s.pid > 1 && run('/bin/ps', ['-o', 'comm=', '-p', String(s.pid)]).trim().endsWith('say')) process.kill(s.pid)
    if (s.restore != null && Number.isFinite(Number(s.restore))) setVolume(s.restore)
  } catch {}
  try { fs.unlinkSync(STATE) } catch {}
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'voices') {
  const zh = (v) => (v.lang === 'zh_CN' ? 0 : v.lang.startsWith('zh_') ? 1 : v.lang.startsWith('en_') ? 2 : 3)
  console.log(JSON.stringify(voices().sort((a, b) => zh(a) - zh(b))))
} else if (cmd === 'stop') {
  stop()
  console.log('ok')
} else if (cmd === 'say') {
  let o
  try { o = JSON.parse(Buffer.from(arg || '', 'base64').toString('utf8')) } catch { console.error('error: bad request'); process.exit(2) }
  const text = String(o?.text || '').trim().slice(0, 2000)
  if (!text) { console.error('error: 没有要念的字'); process.exit(2) }
  const all = voices()
  // 没指定（或系统里没有）：优先婷婷，没有就第一个普通话嗓音，再没有就用系统默认
  const voice = all.find((v) => v.name === o.voice) ? o.voice : (all.find((v) => v.lang === 'zh_CN' && v.name.startsWith('Tingting')) || all.find((v) => v.lang === 'zh_CN'))?.name || ''
  const rate = Math.max(80, Math.min(400, Math.round(Number(o.rate) || 180)))
  stop() // 上一句没念完就打断
  let restore = null
  const want = o.volume == null || o.volume === '' ? null : Math.max(0, Math.min(100, Math.round(Number(o.volume))))
  if (want != null && Number.isFinite(want)) {
    const cur = Number(run('/usr/bin/osascript', ['-e', 'output volume of (get volume settings)']).trim())
    if (Number.isFinite(cur) && cur !== want) { restore = cur; run('/usr/bin/osascript', ['-e', `set volume output volume ${want}`, '-e', 'set volume output muted false']) }
  }
  const args = [...(voice ? ['-v', voice] : []), '-r', String(rate), '--', text]
  // 念完把音量调回去、清掉状态：用一个分离的 node 小进程等 say 结束。参数都从 argv 传（不拼进代码）
  const waiter = spawn(process.execPath, ['-e', `
    const { spawn, execFileSync } = require('child_process'), fs = require('fs'), path = require('path')
    const [say, state, argsJson, restoreJson] = process.argv.slice(1)
    const restore = JSON.parse(restoreJson)
    const p = spawn(say, JSON.parse(argsJson), { stdio: 'ignore' })
    fs.mkdirSync(path.dirname(state), { recursive: true })
    fs.writeFileSync(state, JSON.stringify({ pid: p.pid, restore }))
    p.on('exit', () => {
      try { const s = JSON.parse(fs.readFileSync(state, 'utf8')); if (s.pid !== p.pid) return } catch { return }
      if (restore != null) try { execFileSync('/usr/bin/osascript', ['-e', 'set volume output volume ' + Number(restore)]) } catch {}
      try { fs.unlinkSync(state) } catch {}
    })
  `, SAY, STATE, JSON.stringify(args), JSON.stringify(restore)], { detached: true, stdio: 'ignore' })
  waiter.unref()
  console.log(`ok ${voice || 'default'}`)
} else {
  console.error('error: unknown command')
  process.exit(2)
}
