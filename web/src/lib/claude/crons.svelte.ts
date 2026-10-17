// Claude 会话里的定时任务（CronCreate 建的，只活在会话里）：从会话记录还原出来，手机上看状态、一键发提示词管理
import { sendRaw } from '$lib/api'
import { ui } from '$lib/session.svelte'
import { t as tt } from '$lib/i18n'

export type CronLast = { ts: number; count: number; result?: string; running?: boolean; manual?: boolean }
export type CronTask = {
  id: string; cron: string; prompt: string; recurring: boolean; createdAt: number
  expiresAt?: number; stoppedAt?: number; expired?: boolean; fired?: boolean; last?: CronLast
}
export type CronData = { tasks: CronTask[]; stopped: CronTask[]; busy?: boolean; now?: number }

export const crons = $state({ pane: '', data: null as CronData | null, at: 0 })

let seq = 0
export async function refreshCrons(fresh = false) {
  const pane = ui.current
  if (!pane || ui.claude?.agent !== 'claude') { crons.pane = pane || ''; crons.data = null; return }
  const mine = ++seq
  try {
    const r = await fetch(`api/crons?pane=${pane}${fresh ? '&fresh' : ''}`, { cache: 'no-store' })
    if (!r.ok || mine !== seq || ui.current !== pane) return
    crons.data = await r.json()
    crons.pane = pane
    crons.at = Date.now()
  } catch {}
}
setInterval(() => { if (document.visibilityState === 'visible' && ui.claude?.agent === 'claude') refreshCrons() }, 60000)

/** 任务名：提示词开头方括号里第一个逗号 / 冒号 / 括号之前的部分，比如「巡检 1/3」 */
export function cronName(prompt: string) {
  const m = /^\s*\[([^\]]*)\]/.exec(prompt)
  return m ? m[1].split(/[：，（(,:]/)[0].trim() : prompt.slice(0, 30)
}
/** 方括号里的完整说明（任务名之后的部分），没有就空 */
export function cronNote(prompt: string) {
  const m = /^\s*\[([^\]]*)\]/.exec(prompt)
  if (!m) return ''
  return m[1].slice(cronName(prompt).length).replace(/^[：，,:\s]+/, '')
}
/** 方括号之后的正文 */
export const cronBody = (prompt: string) => prompt.replace(/^\s*\[[^\]]*\]\s*/, '')

// ---------- cron 表达式（分 时 日 月 周，本地时间） ----------
function field(spec: string, lo: number, hi: number): Set<number> | null {
  if (spec === '*') return null
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/')
    const step = Number(stepS || 1)
    let a = lo, b = hi
    if (range !== '*') {
      const [x, y] = range.split('-').map(Number)
      a = x; b = y ?? (stepS ? hi : x)
    }
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 6 ? 0 : v)
  }
  return out
}

export function nextRun(cron: string, from = new Date()): Date | null {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return null
  try {
    const [mi, h, dom, mon, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4], 0, 6)]
    const t = new Date(from)
    t.setSeconds(0, 0)
    t.setMinutes(t.getMinutes() + 1)
    for (let i = 0; i < 60 * 24 * 370; i++) {
      const dayOk = dom && dow ? dom.has(t.getDate()) || dow.has(t.getDay()) : (!dom || dom.has(t.getDate())) && (!dow || dow.has(t.getDay()))
      if ((!mon || mon.has(t.getMonth() + 1)) && dayOk && (!h || h.has(t.getHours())) && (!mi || mi.has(t.getMinutes()))) return t
      t.setMinutes(t.getMinutes() + 1)
    }
  } catch {}
  return null
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 人话排期：每 2 小时 :13、每天 10:07、18:07 …；认不出就原样 */
export function humanCron(cron: string) {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return cron
  const [mi, h, dom, mon, dow] = f
  const everyMin = /^\*\/(\d+)$/.exec(mi)
  if (everyMin && h === '*' && dom === '*' && mon === '*' && dow === '*') return tt('每 {n} 分钟', { n: everyMin[1] })
  if (!/^[\d,]+$/.test(mi)) return cron
  const mins = mi.split(',').map((m) => `:${pad(+m)}`).join(tt('、'))
  if (dom === '*' && mon === '*' && dow === '*') {
    if (h === '*') return tt('每小时 {m}', { m: mins })
    const step = /^\*\/(\d+)$/.exec(h)
    if (step) return tt('每 {n} 小时 {m}', { n: step[1], m: mins })
    if (/^[\d,]+$/.test(h) && !mi.includes(',')) {
      const hs = h.split(',').map(Number)
      const gap = hs[1] - hs[0]
      // 1,5,9,13,17,21 这种等间隔铺满一天的，说成「每 4 小时」
      if (hs.length > 2 && 24 % gap === 0 && hs.length === 24 / gap && hs.every((x, i) => x === hs[0] + i * gap)) return tt('每 {n} 小时 {m}', { n: gap, m: `:${pad(+mi)}` })
      return tt('每天 {t}', { t: hs.map((x) => `${pad(x)}:${pad(+mi)}`).join(tt('、')) })
    }
  }
  if (/^\d+$/.test(h) && /^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*' && !mi.includes(',')) return tt('{mon}月{dom}日 {t}', { mon, dom, t: `${pad(+h)}:${pad(+mi)}` })
  return cron
}

export function clock(ts: number) {
  const d = new Date(ts * 1000), now = new Date()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return hm
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return tt('昨天 {t}', { t: hm })
  const t = new Date(now); t.setDate(now.getDate() + 1)
  if (d.toDateString() === t.toDateString()) return tt('明天 {t}', { t: hm })
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
/** bare：只要时长，不带「后 / 前」 */
export function relative(ms: number, bare = false) {
  const m = Math.round(Math.abs(ms) / 60000)
  const s = m < 1 ? tt('不到 1 分钟') : m < 60 ? tt('{n} 分钟', { n: m }) : m < 60 * 36 ? (m % 60 ? tt('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 }) : tt('{h} 小时', { h: Math.floor(m / 60) })) : tt('{n} 天', { n: Math.round(m / 1440) })
  if (bare) return s
  return ms >= 0 ? tt('{d}后', { d: s }) : tt('{d}前', { d: s })
}

// ---------- 管理：都是往会话里发一条提示词，让 Claude 自己用 CronDelete / CronCreate 处理 ----------
const quote = (prompt: string) => `<<<任务提示词开始\n${prompt}\n任务提示词结束>>>`
export const cronPrompts = {
  run: (t: CronTask) => `[手机面板] 立即执行一次定时任务 ${t.id}（${cronName(t.prompt)}），不改它的排期，照任务要求做完并汇报。任务内容：\n${t.prompt}`,
  stop: (t: CronTask) => `[手机面板] 停止定时任务 ${t.id}（${cronName(t.prompt)}）：用 CronDelete 删掉它，不要新建，然后用一句话确认。`,
  restart: (t: CronTask) =>
    `[手机面板] 重启定时任务 ${t.id}（${cronName(t.prompt)}）：先用 CronDelete 删掉它，再用 CronCreate 重新创建——cron 用「${t.cron}」，recurring 为 ${t.recurring}，prompt 原样用下面这段（一字不改，不要现在执行它）。这样会重置 7 天自动过期。完成后用一句话告诉我新任务 ID。\n${quote(t.prompt)}`,
  restore: (t: CronTask) =>
    `[手机面板] 恢复之前停掉的定时任务（${cronName(t.prompt)}）：用 CronCreate 重新创建——cron 用「${t.cron}」，recurring 为 ${t.recurring}，prompt 原样用下面这段（一字不改，不要现在执行它）。完成后用一句话告诉我新任务 ID。\n${quote(t.prompt)}`,
}

/** 发一条多行提示词到当前会话：括号粘贴，回车单独发（Claude Code 不会把回车当成粘贴内容） */
export function sendPrompt(text: string) {
  if (!ui.current) return
  sendRaw(ui.current, `\x1b[200~${text}\x1b[201~`, false)
  setTimeout(() => sendRaw(ui.current, '\r', false), 300)
}
