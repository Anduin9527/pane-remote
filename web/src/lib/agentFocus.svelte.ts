// Claude Code 有后台 subagent 时，输入框下面会列出这些 agent。空输入框按 ↓ 焦点就会跑到这个列表上：
// 打的字进不了输入框，回车变成「打开选中的 agent」，选中 subagent 时按 x 还会停掉它；
// 回车打开了 subagent 后，消息会发给那个 subagent，不是主会话。这里从画面认出这些状态，并一步步按键回到主会话输入框。
import { sendRaw } from './api'
import * as session from './session.svelte'
import { ui, onFrame } from './session.svelte'

export type AgentFocus =
  | { kind: 'ok' }
  | { kind: 'list'; selected: string; viewing: string } // 焦点在 agent 列表上；selected = 选中的那行，viewing = 正在看的 subagent（看 main 时为空）
  | { kind: 'viewing'; viewing: string } // 焦点在输入框，但在看 subagent：消息会发给它

// 去掉颜色、字符集切换（ESC ( B）等控制序列；Claude Code 在 ❯ 后面用的是不换行空格，统一成普通空格
const plain = (l: string) =>
  l.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\u00a0/g, ' ')

export function detectAgentFocus(lines: string[] = session.lines): AgentFocus {
  const tail = lines.slice(-14).map(plain)
  let viewing = ''
  let selected = ''
  let listHint = false
  for (const l of tail) {
    const m = /^❯\s*Message @([^\s…]+)/.exec(l)
    if (m) viewing = m[1]
    if (/^\s*(↑\/↓ to select|Enter to view)/.test(l)) listHint = true
    const s = /^❯\s*[⏺◯]\s*(\S+)/.exec(l)
    if (s) selected = s[1]
  }
  if (listHint && selected) return { kind: 'list', selected, viewing }
  if (viewing) return { kind: 'viewing', viewing }
  return { kind: 'ok' }
}

const nextFrame = (ms = 1200) => new Promise<void>((resolve) => {
  const t = setTimeout(() => { off(); resolve() }, ms)
  const off = onFrame(() => { clearTimeout(t); off(); setTimeout(resolve, 120) })
})

let running = false
/** 一步步按键回到主会话的输入框：每按一下都重新看画面再决定下一步（多按一下 ↑ 会把上一条历史填进输入框） */
export async function backToMain(): Promise<boolean> {
  if (running || !ui.current) return false
  running = true
  const pane = ui.current
  try {
    for (let i = 0; i < 12 && ui.current === pane; i++) {
      const s = detectAgentFocus()
      if (s.kind === 'ok') return true
      let key: string
      if (s.kind === 'viewing') key = '\x1b[B' // 先进到列表里
      else if (s.selected !== 'main') key = '\x1b[A' // 往上挪到 main
      else key = s.viewing ? '\r' : '\x1b[A' // 在看 subagent：回车打开 main；在看 main：↑ 退回输入框
      sendRaw(pane, key, false)
      await nextFrame()
    }
    return detectAgentFocus().kind === 'ok'
  } finally {
    running = false
  }
}
