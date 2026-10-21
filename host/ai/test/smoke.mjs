#!/usr/bin/env node
// 真调用冒烟测试（会花一点额度，每家用最便宜的模型、极短问答）：
//   node host/ai/test/smoke.mjs            全部 8 项（9 次真调用：cursor 看图 = 转译 1 次 + 回答 1 次）
//   node host/ai/test/smoke.mjs claude     只跑名字里带 claude 的
// 打印每项的首字延迟（ttft，从发请求算，含进程启动）、总耗时、是否用了常驻备用进程、用量
import { createAi } from '../index.mjs'
import { makePng } from './png.mjs'

const only = process.argv[2] || ''
const IMG = `data:image/png;base64,${makePng().toString('base64')}`
const SYS = 'Reply in at most eight words.'
const imgMsg = (q) => [{ role: 'system', content: SYS }, { role: 'user', content: [{ type: 'text', text: q }, { type: 'image_url', image_url: { url: IMG } }] }]
const Q_IMG = 'What text is in the image, and what color is the square?'
const CODEX = 'codex/gpt-5.6-luna@low'
const CURSOR = 'cursor/composer-2.5-fast'

const cases = [
  { name: 'claude text (cold)', req: { model: 'claude/haiku', messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Name one primary color.' }] } },
  { name: 'claude image (warm spare)', req: { model: 'claude/haiku', messages: imgMsg(Q_IMG) }, expect: /42/ },
  { name: 'claude structured', req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'What is 2+3?' }], responseFormat: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } }, check: (r) => r.structured?.answer === 5 },
  {
    name: 'claude tool round trip',
    req: { model: 'claude/haiku', messages: [{ role: 'user', content: 'Call the get_secret_number tool, then reply with just the number it returns.' }], tools: [{ type: 'function', function: { name: 'get_secret_number', description: 'Returns the secret number.', parameters: { type: 'object', properties: {} } } }] },
    io: { callTool: async (name) => (name === 'get_secret_number' ? { secret: 4817 } : null) },
    check: (r) => r.toolCalls.length === 1 && /4817/.test(r.text),
  },
  { name: 'codex text', req: { model: CODEX, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Name one primary color.' }] } },
  {
    name: 'codex image + structured',
    req: { model: CODEX, messages: [{ role: 'user', content: [{ type: 'text', text: Q_IMG }, { type: 'image_url', image_url: { url: IMG } }] }], responseFormat: { type: 'json_schema', json_schema: { name: 'img', schema: { type: 'object', properties: { text: { type: 'string' }, color: { type: 'string' } }, required: ['text', 'color'], additionalProperties: false } } } },
    check: (r) => /42/.test(r.structured?.text) && /red/i.test(r.structured?.color),
  },
  { name: 'cursor text', req: { model: CURSOR, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Name one primary color.' }] } },
  { name: 'cursor image (bridged)', req: { model: CURSOR, messages: imgMsg(Q_IMG) }, expect: /42/ },
]

const ai = createAi()
const models = await ai.models()
console.log(`models: ${models.length}`, Object.keys(ai.skipped).length ? `skipped: ${JSON.stringify(ai.skipped)}` : '')
const rows = []
for (const c of cases) {
  if (only && !c.name.includes(only)) continue
  let streamed = ''
  let chunks = 0
  try {
    const r = await ai.completeAdvanced(c.req, { onChunk: (x) => { if (x.content) { streamed += x.content; chunks++ } }, ...(c.io || {}) })
    const ok = (c.check ? c.check(r) : true) && (!c.expect || c.expect.test(r.text)) && streamed === r.text
    rows.push({ case: c.name, ok, model: r.model, native: r.nativeModel, ttftMs: r.ttftMs, agentTtftMs: r.agentTtftMs, ms: r.ms, warm: r.warm, chunks, bridge: r.bridge && { model: r.bridge.model, ms: r.bridge.ms }, usage: r.usage, text: r.text.slice(0, 120), structured: r.structured, toolCalls: r.toolCalls })
  } catch (e) {
    rows.push({ case: c.name, ok: false, error: `${e.code || ''} ${e.message}`.slice(0, 400) })
  }
  console.log(JSON.stringify(rows.at(-1)))
}
ai.close()
console.log('\ncase'.padEnd(30), 'ok', 'ttft(ms)', 'total(ms)', 'warm')
for (const r of rows) console.log(r.case.padEnd(29), r.ok ? 'ok' : 'FAIL', String(r.ttftMs ?? '-').padStart(8), String(r.ms ?? '-').padStart(9), r.warm ? 'warm' : '')
process.exit(rows.every((r) => r.ok) ? 0 : 1)
