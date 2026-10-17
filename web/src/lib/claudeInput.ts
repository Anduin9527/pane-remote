// 从终端画面里读出 Claude Code 输入框的内容：两条灰色横线之间、以「❯」开头的那几行。
// 正常样式的字 = 已经输入的内容（可能是在电脑上打的，或按 Tab 采纳的推荐）；暗淡样式（SGR 2）的字 = Claude 的推荐 / 占位提示。
const RULE = /^[\s─━]{10,}$/

type Seg = { text: string; dim: boolean; inverse?: boolean }
function segments(raw: string): Seg[] {
  const out: Seg[] = []
  let dim = false
  let inverse = false
  const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b\[[0-9;:?]*[A-Za-z]|([^\x1b]+)/g
  for (const m of raw.matchAll(re)) {
    if (m[2] !== undefined) { out.push({ text: m[2], dim, inverse }); continue }
    if (m[1] === undefined) continue
    const ps = m[1] === '' ? ['0'] : m[1].split(';')
    for (const p of ps) {
      if (p === '0' || p === '') { dim = false; inverse = false }
      else if (p === '2') dim = true
      else if (p === '22') dim = false
      else if (p === '7') inverse = true
      else if (p === '27') inverse = false
    }
  }
  return out
}
const plain = (raw: string) => segments(raw).map((s) => s.text).join('')

export type ClaudeInput = { typed: string; suggestion: string }

/** 按 agent 读输入框（目前支持 Claude、Codex） */
export function readAgentInput(lines: string[], agent: string | undefined): ClaudeInput | null {
  if (agent === 'codex') return readCodexInput(lines)
  if (agent === 'cursor-agent') return readCursorInput(lines)
  if (!agent || agent === 'claude') return readClaudeInput(lines)
  return null
}

// Codex 的固定占位提示（空输入框里轮换显示的示例），不是根据上下文给的推荐，不显示成推荐
const CODEX_PLACEHOLDERS = [
  /^Ask Codex to do anything/i, /^Explain this codebase/i, /^Summarize recent commits/i, /^Implement \{feature\}/i,
  /^Find and fix a bug in @filename/i, /^Write tests for @filename/i, /^Improve documentation in @filename/i,
  /^Run \/review on my current changes/i, /^Use \/skills to list available skills/i,
]

/** Codex：输入框是底部一块带背景色的区域，以粗体「›」开头，续行缩进两格，到空行结束。
 *  历史里的用户消息也以「›」开头，但都在输入框上面，所以从底部往上找到的第一个「›」行就是输入框。 */
export function readCodexInput(lines: string[]): ClaudeInput | null {
  let start = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    if (/^\s*›/.test(plain(lines[i]))) { start = i; break }
  }
  if (start < 0) return null
  let typed = '', suggestion = ''
  for (let i = start; i < lines.length; i++) {
    const p = plain(lines[i]).replace(/\r/g, '')
    if (i > start && !p.trim()) break
    let drop = i === start ? (p.match(/^\s*›\s?/)?.[0].length ?? 0) : Math.min(2, p.match(/^ */)?.[0].length ?? 0)
    const t: string[] = [], g: string[] = []
    for (const s of segments(lines[i].replace(/\r/g, ''))) {
      let x = s.text
      if (drop > 0) { const cut = Math.min(drop, x.length); x = x.slice(cut); drop -= cut }
      if (x) (s.dim ? g : t).push(x)
    }
    typed += (i > start ? '\n' : '') + t.join('').replace(/\u00a0/g, ' ').replace(/\s+$/, '')
    const gs = g.join('').trim()
    if (gs) suggestion += (suggestion ? ' ' : '') + gs
  }
  typed = typed.replace(/\n+$/, '')
  if (CODEX_PLACEHOLDERS.some((re) => re.test(suggestion))) suggestion = ''
  return { typed, suggestion }
}

export function readClaudeInput(lines: string[]): ClaudeInput | null {
  // 从下往上找：收尾横线、输入行、开头横线
  let end = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const t = plain(lines[i]).replace(/\r/g, '')
    if (RULE.test(t) && t.includes('─')) {
      // 往上找到以 ❯ 开头的输入行，并且再往上是开头横线
      for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
        const tj = plain(lines[j]).replace(/\r/g, '')
        if (RULE.test(tj) && tj.includes('─')) break
        if (/^\s*❯/.test(tj)) { end = i; break }
      }
      if (end >= 0) break
    }
  }
  if (end < 0) return null
  let start = end - 1
  while (start > 0 && !/^\s*❯/.test(plain(lines[start]))) start--
  let typed = '', suggestion = ''
  for (let i = start; i < end; i++) {
    let segs = segments(lines[i].replace(/\r/g, ''))
    // 去掉行首的「❯ 」或续行缩进（两个空格）
    let drop = i === start ? (plain(lines[i]).match(/^\s*❯[\s ]?/)?.[0].length ?? 0) : Math.min(2, (plain(lines[i]).match(/^ */)?.[0].length ?? 0))
    const lineTyped: string[] = [], lineSug: string[] = []
    for (const s of segs) {
      let t = s.text
      if (drop > 0) { const cut = Math.min(drop, t.length); t = t.slice(cut); drop -= cut }
      if (!t) continue
      ;(s.dim ? lineSug : lineTyped).push(t)
    }
    const lt = lineTyped.join('').replace(/ /g, ' ').replace(/\s+$/, '')
    const ls = lineSug.join('').replace(/ /g, ' ').trim()
    typed += (i > start ? '\n' : '') + lt
    if (ls) suggestion += (suggestion ? ' ' : '') + ls
  }
  typed = typed.replace(/\n+$/, '')
  return { typed, suggestion }
}

// cursor-agent 的占位提示，不算推荐
const CURSOR_PLACEHOLDERS = [/^Plan, search, build anything/i, /^Add a follow-up/i]

/** cursor-agent：输入框夹在一行 ▄ 和一行 ▀ 之间，第一行以「→」开头，续行缩进 4 格。
 *  光标是反色画的一个字符：输入框里没有别的正常文字时，它压在占位提示的第一个字母上，算占位的一部分；否则算输入内容。 */
export function readCursorInput(lines: string[]): ClaudeInput | null {
  let bottom = -1, top = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    const p = plain(lines[i])
    if (bottom < 0 && /^\s*▀{10,}/.test(p)) bottom = i
    else if (bottom >= 0 && /^\s*▄{10,}/.test(p)) { top = i; break }
  }
  if (bottom < 0 || top < 0 || bottom - top < 2) return null
  const typedLines: string[] = []
  const sug: string[] = []
  for (let i = top + 1; i < bottom; i++) {
    const p = plain(lines[i]).replace(/\r/g, '')
    let drop = i === top + 1 ? (p.match(/^\s*→\s?/)?.[0].length ?? 0) : Math.min(4, p.match(/^ */)?.[0].length ?? 0)
    // 先看完一整行：有正常文字时，反色的光标字符算输入内容（按原位置放回）；没有时算占位提示
    const pieces: { x: string; kind: 'n' | 'd' | 'i' }[] = []
    for (const s of segments(lines[i].replace(/\r/g, ''))) {
      let x = s.text
      if (drop > 0) { const cut = Math.min(drop, x.length); x = x.slice(cut); drop -= cut }
      if (x) pieces.push({ x, kind: s.inverse ? 'i' : s.dim ? 'd' : 'n' })
    }
    const hasNormal = pieces.some((q) => q.kind === 'n' && q.x.trim())
    const t: string[] = [], g: string[] = []
    for (const q of pieces) (q.kind === 'n' || (q.kind === 'i' && hasNormal) ? t : g).push(q.x)
    typedLines.push(t.join('').replace(/\u00a0/g, ' ').replace(/\s+$/, ''))
    const gs = g.join('').trim()
    if (gs) sug.push(gs)
  }
  let typed = typedLines.join('\n').replace(/\n+$/, '')
  let suggestion = sug.join(' ')
  // 没有正常文字时，反色的光标字符属于占位提示（例如「P」+「lan, search…」）
  if (!typed.trim()) typed = ''
  if (CURSOR_PLACEHOLDERS.some((re) => re.test(suggestion))) suggestion = ''
  return { typed, suggestion }
}
