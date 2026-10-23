// 「在等人操作」的识别：用 Claude Code 真实画面（2026-10-23 在测试 pane 里截的）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, choices, dialogSig } from '../prompt-detect.mjs'

const RULE = '─'.repeat(80)
const DOWN = '\x1b[B', UP = '\x1b[A'

// subagent 弹的 Bash 授权（主对话已经停下、在等后台 agent）
const subagentBash = `⏺ 已经开了一个 general-purpose subagent。
✻ Waiting for 1 background agent to finish
${RULE}
 Bash command · from the general-purpose agent
 Create a directory and list the files
${'╌'.repeat(80)}
 mkdir -p ./made-by-subagent && ls
${'╌'.repeat(80)}
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /private/tmp/x from this
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend · ctrl+f twice to stop background agents`

const elicit = (sql, cur = 0) => `✻ Waiting for 1 background agent to finish
${RULE}
  MCP server “elicit-test” requests your input
  About to run: ${sql}
  Run it on project testproj123?
  ${cur === 0 ? '❯ Accept    Decline' : '  Accept  ❯ Decline'}
  Esc to cancel · ↑/↓ to navigate`

const trust = `${RULE}
 Accessing workspace:
 /private/tmp/elicit
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`

test('subagent 的授权：编号选项照旧', () => {
  assert.equal(detect(subagentBash), 'Do you want to proceed?')
  const c = choices(subagentBash)
  assert.deepEqual(c.map((x) => x.send), [['1'], ['2'], ['3'], ['4'], ['\x1b']])
  assert.equal(c[0].selected, true)
})

test('MCP 确认框：横排 Accept / Decline 变成按钮，按方向键选', () => {
  assert.equal(detect(elicit('select 1')), 'Run it on project testproj123?')
  assert.deepEqual(choices(elicit('select 1')), [
    { label: 'Accept', send: ['\r'], selected: true },
    { label: 'Decline', send: [DOWN, '\r'], selected: false },
    { label: 'Esc', send: ['\x1b'] },
  ])
  // 光标在 Decline 上：Accept 要往前按 ↑（不靠第一项绕回）
  assert.deepEqual(choices(elicit('select 1', 1)).map((x) => x.send), [[UP, '\r'], ['\r'], ['\x1b']])
})

test('信任目录：竖排没编号的选项', () => {
  assert.deepEqual(choices(trust).map((x) => [x.label, x.send]), [
    ['No, exit', ['\r']],
    ['Yes, I trust this folder', [DOWN, '\r']],
    ['Esc', ['\x1b']],
  ])
})

test('对话框指纹：问题一样、内容不同算新问题；只挪光标不算', () => {
  assert.notEqual(dialogSig(elicit('select 1')), dialogSig(elicit('select 2')))
  assert.equal(dialogSig(elicit('select 1')), dialogSig(elicit('select 1', 1)))
  // 横线以上的内容（转圈、计时）变了不影响
  assert.equal(dialogSig(elicit('select 1')), dialogSig(elicit('select 1').replace('Waiting for 1', 'Waiting for 2')))
})

test('普通画面不误报：输入框里的 ❯ 和带两个空格的文字', () => {
  const idle = `⏺ 做完了。\n${RULE}\n❯ 帮我看看  这个  问题\n${RULE}\n  ⏵⏵ auto mode on · esc to interrupt`
  assert.equal(detect(idle), null)
  assert.deepEqual(choices(idle), [])
})
