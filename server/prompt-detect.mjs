// 检测「在等人操作」：只看画面最后几行。Claude Code / codex 的选择器、权限确认、计划确认、MCP 的确认框，常见的 y/n 提示
// 规则和前端 web/src/lib/prompts.ts 一致，改一边要改另一边
export const TAIL = 15
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
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]/g, '')
const tailOf = (text) => stripAnsi(text).replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-TAIL)

/** 从当前选中项挪到第 to 项再回车：往后按 ↓，往前按 ↑（不靠绕回，第一项按 ↑ 会跳到最后一项） */
const arrows = (from, to) => [...Array(Math.abs(to - from)).fill(to > from ? '\x1b[B' : '\x1b[A'), '\r']

/**
 * 没编号、只能用方向键选的选择器，❯ 标出当前项：
 *   横排，比如 MCP 的确认框「❯ Accept    Decline」
 *   竖排，比如信任目录「❯ No, exit」下一行「  Yes, I trust this folder」
 * 返回 [{ text, selected }]，认不出来返回 null
 */
export function selector(tail) {
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
    const same = (l) => l != null && !FOOTER_RE.test(l) && (l.match(/^\s*/)[0].length === col) && l.trim().length <= 60
    const up = [], down = []
    for (let j = i - 1; same(tail[j]) && up.length < 6; j--) up.unshift({ text: tail[j].trim(), selected: false })
    for (let j = i + 1; same(tail[j]) && down.length < 6; j++) down.push({ text: tail[j].trim(), selected: false })
    const opts = [...up, { text: m[2].trim(), selected: true }, ...down]
    if (opts.length >= 2) return opts
  }
  return null
}

/** 等待界面里可以直接点的选项：编号选项（从 1 连续）、方向键选择器、y/n、Esc */
export function choices(text) {
  const tail = tailOf(text)
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
  const sel = waitHit && opts.length < 2 ? selector(tail) : null
  if (waitHit && opts.length >= 2) out.push(...opts)
  else if (sel) {
    const cur = sel.findIndex((o) => o.selected)
    sel.forEach((o, k) => out.push({ label: o.text.slice(0, 80), send: arrows(cur, k), selected: o.selected }))
  } else if (tail.slice(-3).some((l) => YN_RE.test(l))) out.push({ label: 'y', send: ['y', '\r'] }, { label: 'n', send: ['n', '\r'] })
  if (tail.some((l) => /Esc to (cancel|go back|exit)/i.test(l))) out.push({ label: 'Esc', send: ['\x1b'] })
  return out
}

export function detect(text) {
  const tail = tailOf(text)
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

/**
 * 这个确认框的指纹：最后一条横线以下的内容（对话框本身），去掉光标标记（按方向键挪选中项不算新问题）。
 * 只用问题文字去重的话，MCP 每次都问同一句「Run it on project …?」，后面几次就不推了；带上正文，命令不同就是新问题
 */
export function dialogSig(text) {
  const tail = tailOf(text)
  let from = 0
  for (let i = tail.length - 1; i >= 0; i--) if (/^\s*[─━]{20,}\s*$/.test(tail[i])) { from = i + 1; break }
  const s = tail.slice(from).join('\n').replace(/[❯›▶]/g, ' ').replace(/\s+/g, ' ')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
