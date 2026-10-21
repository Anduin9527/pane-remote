// 插件入口匹配：照 whatevertools（@whatevertools/core 的 scoreText + compat-utools 的 text / regex / over）的规则在手机上算。
// 拼音不在前端算：服务端给的列表里，中文功能指令已经带好全拼（py）和首字母（pyi），前端不用带拼音库。
// 只有文字输入，所以 img / files / window 类型的入口这里不会命中。
import type { PluginInfo, EnterAction } from './types'

export type Hit = { plugin: PluginInfo; code: string; label: string; type: string; payload: unknown; score: number }

/** 前缀 > 包含 > 子序列，和 core 的 scoreText 一样 */
export function scoreText(query: string, label: string): number {
  const q = query.trim().toLowerCase()
  const l = label.toLowerCase()
  if (!q) return 0
  if (l === q) return 1
  if (l.startsWith(q)) return 0.9
  if (l.includes(q)) return 0.7
  let i = 0
  for (const ch of l) if (ch === q[i]) i++
  return i === q.length ? 0.4 : 0
}

/** 拼音：首字母 / 全拼的前缀、包含，和 compat-utools 的 scorePinyin 一样 */
export function scorePinyin(query: string, py?: string, pyi?: string): number {
  const q = query.trim().toLowerCase()
  if (!q || !/^[a-z]+$/.test(q) || !py || !pyi) return 0
  if (pyi === q || py === q) return 0.95
  if (pyi.startsWith(q) || py.startsWith(q)) return 0.8
  if (pyi.includes(q) || py.includes(q)) return 0.55
  return 0
}

const REGEX_INPUT_LIMIT = 10000
const regexCache = new Map<string, RegExp | null>()
/** "/.../flags" 形式的正则；匹配一切的按 uTools 规则忽略 */
function regexOf(literal: unknown): RegExp | null {
  if (typeof literal !== 'string') return null
  if (regexCache.has(literal)) return regexCache.get(literal)!
  let re: RegExp | null = null
  const m = /^\/(.*)\/([dgimsuvy]*)$/s.exec(literal)
  if (m) try { re = new RegExp(m[1], m[2].replace(/[gy]/g, '')) } catch {}
  if (re && re.test('') && re.test('\u0001any thing \n 123')) re = null
  regexCache.set(literal, re)
  return re
}
const within = (n: number, min?: unknown, max?: unknown) => (typeof min !== 'number' || n >= min) && (typeof max !== 'number' || n <= max)

/** 输入一段文字，按得分从高到低给出命中的入口（同一插件同一功能同一类型只留最高的一条） */
export function match(list: PluginInfo[], text: string): Hit[] {
  const q = text
  if (!q.trim()) return []
  const best = new Map<string, Hit>()
  for (const p of list) {
    for (const f of p.features) {
      for (const cmd of f.cmds) {
        let hit: { payload: unknown; score: number } | null = null
        if (cmd.type === 'text') {
          const s = Math.max(scoreText(q, cmd.label), scorePinyin(q, cmd.py, cmd.pyi))
          if (s > 0) hit = { payload: cmd.label, score: 100 * s }
        } else if (cmd.type === 'regex') {
          if (q.length <= REGEX_INPUT_LIMIT && within(q.length, cmd.minLength, cmd.maxLength) && regexOf(cmd.match)?.test(q)) hit = { payload: q, score: 60 }
        } else if (cmd.type === 'over') {
          const ex = q.length <= REGEX_INPUT_LIMIT ? regexOf(cmd.exclude) : null
          if (within(q.length, cmd.minLength ?? 1, cmd.maxLength ?? 10000) && !ex?.test(q)) hit = { payload: q, score: 20 }
        }
        if (!hit) continue
        const k = `${p.id}\u0000${f.code}\u0000${cmd.type}`
        const prev = best.get(k)
        if (!prev || prev.score < hit.score) best.set(k, { plugin: p, code: f.code, label: cmd.label, type: cmd.type, payload: hit.payload, score: hit.score })
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

/** 命中 → 进入插件时的 action（whatevertools 的 lifecycle.onEnter / uTools 的 onPluginEnter 收到的） */
export const actionOf = (h: Hit): EnterAction => ({ code: h.code, type: h.type, payload: h.payload, from: 'main' })

/** 没有输入时打开插件：第一个有功能指令的功能 */
export function defaultAction(p: PluginInfo): EnterAction {
  const f = p.features.find((x) => x.cmds.some((c) => c.type === 'text')) || p.features[0]
  const c = f?.cmds.find((x) => x.type === 'text')
  return { code: f?.code || '', type: 'text', payload: c?.label || '', from: 'main' }
}
