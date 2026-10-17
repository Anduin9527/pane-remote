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
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g, '')

export type PromptButton = { label: string; send: string[]; kind: 'option' | 'yes' | 'no' | 'esc' | 'enter'; selected?: boolean }
export type Prompt = { question: string; buttons: PromptButton[] }

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
  if (waitHit && opts.length >= 2) {
    for (const o of opts) buttons.push({ label: `${o.n}. ${o.text}`, send: [String(o.n)], kind: 'option', selected: o.selected })
  } else if (ynHit) {
    buttons.push({ label: 'y', send: ['y', '\r'], kind: 'yes' }, { label: 'n', send: ['n', '\r'], kind: 'no' })
  }
  if (tail.some((l) => /Enter to (select|confirm|submit|continue)|Press enter/i.test(l)) && !buttons.length) buttons.push({ label: '确认', send: ['\r'], kind: 'enter' })
  if (tail.some((l) => /Esc to (cancel|go back|exit)/i.test(l))) buttons.push({ label: 'Esc', send: ['\x1b'], kind: 'esc' })
  if (!buttons.length) return null
  return { question: question.slice(0, 160), buttons }
}
