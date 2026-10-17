// 推送通知：定时看所有 pane 最后几行，出现「等你选择/确认」的界面就给订阅过的手机发 Web Push
import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { config } from './config.mjs'

const DATA = config.dataDir
const SUBS_FILE = path.join(DATA, 'subscriptions.json')
const VAPID_FILE = path.join(DATA, 'vapid.json')
const SCAN_MS = Number(process.env.SCAN_MS || 3000)
const IDLE_SECONDS = Number(process.env.NOTIFY_IDLE_SECONDS || 120) // 电脑键鼠空闲超过这么久才推（人在电脑前就不打扰手机）
const TAIL = 15

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
let vapid
try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) } catch {
  vapid = webpush.generateVAPIDKeys()
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid), { mode: 0o600 })
}
webpush.setVapidDetails(config.vapidSubject, vapid.publicKey, vapid.privateKey)

const PREFS_FILE = path.join(DATA, 'prefs.json')
let prefs = { stop: true } // stop：Claude / Codex 一轮做完也推送
try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } } catch {}
export const getPrefs = () => prefs
export function setPrefs(p) {
  if (typeof p?.stop === 'boolean') prefs.stop = p.stop
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs), { mode: 0o600 })
  return prefs
}

let subs = []
try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')) } catch {}
const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), { mode: 0o600 })

export const publicKey = vapid.publicKey
export function subscribe(sub) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('bad subscription')
  subs = subs.filter((s) => s.endpoint !== sub.endpoint)
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() })
  saveSubs()
}
export function unsubscribe(endpoint) {
  subs = subs.filter((s) => s.endpoint !== endpoint)
  saveSubs()
}
export const hasSub = (endpoint) => subs.some((s) => s.endpoint === endpoint)

export async function notify(payload) {
  const body = JSON.stringify(payload)
  const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, body, { TTL: 600, urgency: 'high', topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) })))
  const gone = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = r.reason?.statusCode
      console.log(`push failed ${code || ''} ${r.reason?.body || r.reason?.message || ''}`.trim())
      if (code === 404 || code === 410) gone.push(subs[i].endpoint)
    }
  })
  if (gone.length) { subs = subs.filter((s) => !gone.includes(s.endpoint)); saveSubs() }
  return { sent: results.filter((r) => r.status === 'fulfilled').length, failed: results.length - results.filter((r) => r.status === 'fulfilled').length }
}

// ---------- 检测「在等人操作」 ----------
// 只看最后几行：Claude Code / codex 的选择器、权限确认、计划确认，常见的 y/n 提示
const WAIT_RES = [
  /Enter to (select|confirm|submit|continue)/i,
  /Esc to (cancel|go back|exit)/i,
  /Do you want to (proceed|make this edit|create|allow|run|overwrite)/i,
  /Would you like to proceed/i,
  /Press enter to (confirm|continue)/i,
  /Allow (once|always|this command)/i,
]
const YN_RE = /[[(](y\/n|Y\/n|y\/N)[\])]\s*[:?？]?\s*$/
const OPT_RE = /^[\s│┃|]*([❯›>▶])?\s*(\d{1,2})[.)]\s+(.+?)[\s│┃|]*$/
/** 等待界面里可以直接点的选项：编号选项（从 1 连续）、y/n、Esc（和前端 prompts.ts 规则一致） */
function choices(text) {
  const tail = stripAnsi(text).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-TAIL)
  const out = []
  const opts = []
  for (const l of tail) {
    const m = l.match(OPT_RE)
    if (!m) continue
    const n = Number(m[2])
    if (n === 1) opts.length = 0
    if (n === opts.length + 1) opts.push({ label: `${n}. ${m[3].trim()}`.slice(0, 80), send: [String(n)], selected: !!m[1] })
  }
  const waitHit = tail.some((l) => WAIT_RES.some((re) => re.test(l)))
  if (waitHit && opts.length >= 2) out.push(...opts)
  else if (tail.slice(-3).some((l) => YN_RE.test(l))) out.push({ label: 'y', send: ['y', '\r'] }, { label: 'n', send: ['n', '\r'] })
  if (tail.some((l) => /Esc to (cancel|go back|exit)/i.test(l))) out.push({ label: 'Esc', send: ['\x1b'] })
  return out
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g, '')
function detect(text) {
  const lines = stripAnsi(text).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  const tail = lines.slice(-TAIL)
  let hit = tail.findIndex((l) => WAIT_RES.some((re) => re.test(l)))
  // y/n 提示：必须在行尾，而且是最后 3 行之一（光标停在那儿等输入），避免命令文本里出现的 [y/N] 误报
  if (hit < 0) {
    const k = tail.slice(-3).findIndex((l) => YN_RE.test(l))
    if (k >= 0) hit = tail.length - Math.min(3, tail.length) + k
  }
  if (hit < 0) return null
  // 问题文字：命中行往上找最近一个以问号结尾的行，找不到就用命中行
  let question = ''
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i].replace(/^[\s│┃|>❯›]+|[\s│┃|]+$/g, '')
    if (/[?？]$/.test(l)) { question = l; break }
  }
  return (question || tail[hit].trim()).slice(0, 160)
}

const state = new Map() // pane → { sig, missing, hash, changedAt, seenAt, prompt, doneAt, inputAt, pushedAt }
const COOLDOWN_MS = 15000 // 同一个 pane 15 秒内只推一次（hook 和画面检测可能同时命中）
const blank = (now) => ({ sig: null, missing: 0, hash: null, changedAt: 0, seenAt: now, prompt: '', doneAt: 0, inputAt: 0, pushedAt: 0 })
/** 手机往 pane 里发了输入：清掉「已完成」 */
export function markInput(pane) {
  const st = state.get(String(pane))
  if (st) st.inputAt = Date.now()
}
const RUNNING_MS = 6000 // 最近这么久画面有变化 = 在跑
/** 所有 pane 的状态：waiting（等你操作）/ running（画面在变）/ idle，以及手机上有没有看过最新内容 */
export function states() {
  const now = Date.now()
  const out = {}
  for (const [pane, st] of state) {
    out[pane] = {
      state: st.prompt ? 'waiting' : now - st.changedAt < RUNNING_MS ? 'running' : st.doneAt > st.inputAt ? 'done' : 'idle',
      prompt: st.prompt || '',
      choices: st.prompt ? st.choices || [] : [],
      unread: st.changedAt > st.seenAt,
    }
  }
  return out
}
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

let lastList = []
let lastIdle = 1e9
const cleanTitle = (info, pane) => (info?.title || `pane ${pane}`).replace(/^[⠀-⣿✳✻✽·◐◓◑◒⠂⠐*]+\s*/, '')

/** 推送前的统一判断：有订阅、不是测试 workspace、手机没在看、人不在电脑前、冷却时间已过 */
async function pushFor(pane, isWatching, payload, why) {
  const st = state.get(pane)
  const info = lastList.find((p) => String(p.pane_id) === pane)
  if (!subs.length || !st) return false
  if (isWatching(pane)) { console.log(`skip ${why} pane ${pane}: viewing on phone`); return true }
  if (lastIdle < IDLE_SECONDS) return false
  if (Date.now() - st.pushedAt < COOLDOWN_MS) return true
  st.pushedAt = Date.now()
  const r = await notify({ ...payload, title: `${cleanTitle(info, pane)} ${payload.title}`, pane, tag: `pane-${pane}` })
  console.log(`notify(${why}) pane ${pane}: ${payload.body} → ${JSON.stringify(r)}`)
  return true
}

// hook（电脑上的 pane-event）记下的事件：回合结束、需要操作、用户发了新输入
let eventsOffset = null
async function readEvents(bridge, isWatching, onOpen) {
  const out = await bridge(`events ${eventsOffset ?? 0}`)
  const nl = out.indexOf('\n')
  const size = Number(out.slice(0, nl < 0 ? undefined : nl))
  const first = eventsOffset === null
  eventsOffset = size
  if (first || nl < 0) return // 刚启动：只记下位置，不补推以前的事件
  for (const line of out.slice(nl + 1).split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.kind === 'open') { onOpen?.(ev.msg); continue }
    const pane = String(ev.pane)
    const st = state.get(pane) || blank(Date.now())
    state.set(pane, st)
    const t = Math.round(ev.t * 1000)
    if (ev.kind === 'prompt') { st.inputAt = t; continue }
    if (ev.kind === 'stop' || ev.kind === 'failure') {
      st.doneAt = t
      if (prefs.stop) await pushFor(pane, isWatching, { title: ev.kind === 'failure' ? '出错停下了' : '做完了', body: ev.msg || '轮到你了' }, ev.kind)
    } else if (ev.kind === 'notify' || ev.kind === 'permission') {
      await pushFor(pane, isWatching, { title: '等你操作', body: ev.msg || '需要你确认' }, ev.kind)
    }
  }
}

export function startMonitor({ bridge, isWatching, active, onOpen }) {
  let busy = false
  setInterval(async () => {
    // 有推送订阅、或手机最近在用（要看状态列表）才扫，不然不打扰电脑
    if (busy || (subs.length === 0 && !active())) return
    busy = true
    try {
      const out = await bridge('tails')
      const idle = Number((out.match(/^idle (\d+)/) || [])[1] ?? 1e9)
      const [head, ...chunks] = out.split('\x1e')
      const list = JSON.parse(head.replace(/^idle \d+\n/, ''))
      lastList = list
      lastIdle = idle
      const seen = new Set()
      const now = Date.now()
      for (const chunk of chunks) {
        const nl = chunk.indexOf('\n')
        const pane = chunk.slice(0, nl).trim()
        const body = chunk.slice(nl + 1)
        seen.add(pane)
        const q = detect(body)
        const st = state.get(pane) || blank(now)
        // 标题里的转圈动画不算；只比画面文字
        const h = hash(stripAnsi(body))
        if (st.hash !== null && h !== st.hash) st.changedAt = now
        st.hash = h
        st.prompt = q || ''
        st.choices = q ? choices(body) : []
        if (isWatching(pane)) st.seenAt = now
        if (q) {
          st.missing = 0
          if (q !== st.sig && subs.length) {
            state.set(pane, st)
            // 人在电脑前时 pushFor 返回 false：不记下，问题一直挂着的话电脑空闲够久后再推
            if (await pushFor(pane, isWatching, { title: '等你操作', body: q }, 'screen')) st.sig = q
          }
        } else if (st.sig && ++st.missing >= 2) {
          st.sig = null // 界面消失（已处理）后再出现新问题才会再推
        }
        state.set(pane, st)
      }
      for (const k of state.keys()) if (!seen.has(k)) state.delete(k)
      await readEvents(bridge, isWatching, onOpen).catch((e) => console.log(`events: ${e.message}`))
    } catch (e) {
      console.log(`monitor: ${e.message}`)
    } finally {
      busy = false
    }
  }, SCAN_MS)
}
export { detect }
