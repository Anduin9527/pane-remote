import { t } from '$lib/i18n'
// 从当前画面底部识别「在等你操作」的界面，拆出可点的选项（和 push.mjs 的检测规则一致）
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
const FOOTER_RE = /Enter to |Esc to |to navigate|Tab to /i
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g, '')

export type PromptButton = { label: string; send: string[]; kind: 'option' | 'yes' | 'no' | 'esc' | 'enter'; selected?: boolean }
export type Prompt = { question: string; buttons: PromptButton[] }

/** 从当前选中项挪到第 to 项再回车：往后按 ↓，往前按 ↑（不靠绕回，第一项按 ↑ 会跳到最后一项） */
const arrows = (from: number, to: number) => [...Array(Math.abs(to - from)).fill(to > from ? '\x1b[B' : '\x1b[A'), '\r']

/** 没编号、只能用方向键选的选择器（横排如 MCP 确认框「❯ Accept    Decline」，竖排如信任目录），和 prompt-detect.mjs 的 selector 一致 */
export function selector(tail: string[]): { text: string; selected: boolean }[] | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const raw = tail[i].replace(/[\s│┃|]+$/, '')
    if (!/[❯›▶]/.test(raw) || FOOTER_RE.test(raw)) continue
    const toks = raw.replace(/^[\s│┃|]+/, '').split(/\s{2,}/)
    if (toks.length >= 2 && toks.length <= 4) {
      const opts = toks.map((t) => ({ text: t.replace(/^[❯›▶]\s*/, '').trim(), selected: /^[❯›▶]/.test(t) }))
      if (opts.filter((o) => o.selected).length === 1 && opts.every((o) => o.text && o.text.length <= 30 && !/[❯›▶]/.test(o.text) && !/^\d{1,2}[.)]/.test(o.text))) return opts
      continue
    }
    const m = raw.match(/^(\s*)[❯›▶]\s+(\S.*)$/)
    if (!m || /^\d{1,2}[.)]\s/.test(m[2])) continue
    const col = raw.length - m[2].length
    const same = (l: string | undefined) => l != null && !FOOTER_RE.test(l) && l.match(/^\s*/)![0].length === col && l.trim().length <= 60
    const up: { text: string; selected: boolean }[] = []
    const down: { text: string; selected: boolean }[] = []
    for (let j = i - 1; same(tail[j]) && up.length < 6; j--) up.unshift({ text: tail[j].trim(), selected: false })
    for (let j = i + 1; same(tail[j]) && down.length < 6; j++) down.push({ text: tail[j].trim(), selected: false })
    const opts = [...up, { text: m[2].trim(), selected: true }, ...down]
    if (opts.length >= 2) return opts
  }
  return null
}

export function detectPrompt(lines: string[]): Prompt | null {
  const tail = lines.slice(-40).map((l) => stripAnsi(l).replace(/\r/g, '').trimEnd()).filter((l) => l.trim()).slice(-15)
  if (!tail.length) return null
  const waitHit = tail.some((l) => WAIT_RES.some((re) => re.test(l)))
  const ynHit = tail.slice(-3).some((l) => YN_RE.test(l))
  if (!waitHit && !ynHit) return null

  let question = ''
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i].replace(/^[\s│┃|>❯›]+|[\s│┃|]+$/g, '')
    if (/[?？]$/.test(l)) { question = l; break }
  }

  const buttons: PromptButton[] = []
  // 编号选项：只认从 1 开始连续的一组（避免把普通编号列表当选项）
  const opts: { n: number; text: string; selected: boolean }[] = []
  for (const l of tail) {
    const m = l.match(OPT_RE)
    if (!m) continue
    const n = Number(m[2])
    if (n === 1) opts.length = 0
    if (n === opts.length + 1) opts.push({ n, text: m[3].trim(), selected: !!m[1] })
  }
  const sel = waitHit && opts.length < 2 ? selector(tail) : null
  if (waitHit && opts.length >= 2) {
    for (const o of opts) buttons.push({ label: `${o.n}. ${o.text}`, send: [String(o.n)], kind: 'option', selected: o.selected })
  } else if (sel) {
    const cur = sel.findIndex((o) => o.selected)
    sel.forEach((o, k) => buttons.push({ label: o.text, send: arrows(cur, k), kind: 'option', selected: o.selected }))
  } else if (ynHit) {
    buttons.push({ label: 'y', send: ['y', '\r'], kind: 'yes' }, { label: 'n', send: ['n', '\r'], kind: 'no' })
  }
  if (tail.some((l) => /Enter to (select|confirm|submit|continue)|Press enter/i.test(l)) && !buttons.length) buttons.push({ label: t('确认'), send: ['\r'], kind: 'enter' })
  if (tail.some((l) => /Esc to (cancel|go back|exit)/i.test(l))) buttons.push({ label: 'Esc', send: ['\x1b'], kind: 'esc' })
  if (!buttons.length) return null
  return { question: question.slice(0, 160), buttons }
}
