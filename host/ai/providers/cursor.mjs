// cursor-agent 提供方：-p --mode ask（只读问答）+ stream-json 逐字增量。
// 「不要用工具」必须写进提示：ask 模式照样能读文件 / 搜索，不写的话它会去翻工作目录，很久都回不来。
// 没有图片参数：带图的请求先由看图模型转成文字（见 index.mjs 的 bridgeImages），模型列表里标 vision:'bridged'。
// 没有结构化输出参数：把 JSON Schema 写进提示，再从回答里取 JSON。不支持工具调用。会话会留在 ~/.cursor（没有不留会话的开关）
import { startProc, nowMs } from '../proc.mjs'
import { run } from '../env.mjs'

export const NO_TOOLS = 'Do not use any tools: do not read files, search, or run commands. Answer only from the text in this message.'
const EFFORT = /^(.*)-(low|medium|high|xhigh|max)(-fast)?$/
const EFFORT_WORDS = / (Low|Medium|High|Extra High|Max)(?= |$)/
const CHEAP = /composer.*fast|(^|[-.])(flash|mini|nano|lite|luna|haiku)([-.]|$)/i

export function buildArgs({ model, cwd, prompt }) {
  return ['-p', '--trust', '--mode', 'ask', '--model', model, '--output-format', 'stream-json', '--stream-partial-output', '--workspace', cwd, prompt]
}

// --list-models 的输出：「id - 名字」。同一个模型的不同推理等级（xxx-low / xxx-high / xxx-high-fast）并成一项，
// 推理等级放进 efforts；原始 id 都留在 variants 里（也能直接用 cursor/<原始 id>）
export function parseModels(text) {
  const raw = []
  for (const line of String(text).split('\n')) {
    const m = /^([\w.\-[\]=,]+) - (.+)$/.exec(line.trim())
    if (m) raw.push({ id: m[1], label: m[2].replace(/\s*\((current|default)\)\s*$/i, '').replace(/[\u200b-\u200d]/g, '').replace(/\s+/g, ' ').trim() })
  }
  const groups = new Map()
  for (const r of raw) {
    const m = EFFORT.exec(r.id)
    const base = m ? m[1] + (m[3] || '') : r.id
    const g = groups.get(base) || { model: base, label: '', efforts: [], variants: {} }
    if (m) {
      g.efforts.push(m[2])
      g.variants[m[2]] = r.id
      if (!g.label || m[2] === 'medium') g.label = r.label.replace(EFFORT_WORDS, '')
    } else {
      g.variants[''] = r.id
      g.label = r.label
    }
    groups.set(base, g)
  }
  return [...groups.values()].map((g) => ({
    ...g,
    defaultEffort: g.variants[''] ? undefined : ['medium', 'high', 'low'].find((e) => g.variants[e]) || g.efforts[0],
    tier: CHEAP.test(g.model) ? 'fast' : /opus|fable|xhigh|max|sol/i.test(g.model) ? 'strong' : 'balanced',
    raw: Object.values(g.variants),
  }))
}

// 解析 stream-json：带 timestamp_ms 的 assistant 是增量，最后那条不带时间戳的是整段（有增量时忽略）
export function createParser(cb = {}) {
  const st = { text: '', reasoning: '', result: null, model: '', sawDelta: false, toolCalls: [] }
  st.feed = (line) => {
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.type === 'system' && e.subtype === 'init') st.model = e.model || ''
    else if (e.type === 'thinking' && e.subtype === 'delta' && e.text) { st.reasoning += e.text; cb.onReasoning?.(e.text) }
    else if (e.type === 'assistant') {
      const t = (e.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (!t) return
      if (e.timestamp_ms != null) { st.sawDelta = true; st.text += t; cb.onText?.(t) }
      else if (!st.sawDelta) { st.text += t; cb.onText?.(t) }
    } else if (e.type === 'tool_call') {
      if (e.subtype === 'started') st.toolCalls.push({ name: Object.keys(e.tool_call || {})[0] || 'tool' })
    } else if (e.type === 'result') st.result = e
  }
  return st
}

export function usageOf(r) {
  const u = r?.usage || {}
  return { inputTokens: u.inputTokens || 0, cachedInputTokens: u.cacheReadTokens || 0, outputTokens: u.outputTokens || 0 }
}

export async function listRaw(env) {
  const r = await run('cursor-agent', ['--list-models'], { env, timeout: 30000 })
  if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(0, 200) || 'cursor-agent --list-models failed')
  return r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

export async function available(env) {
  if (env.CURSOR_API_KEY) return { ok: true }
  const r = await run('cursor-agent', ['status'], { env, timeout: 15000 })
  const s = (r.out + r.err).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  return /logged in/i.test(s) && !/not logged in/i.test(s) ? { ok: true } : { ok: false, reason: s.trim().slice(0, 200) || 'cursor-agent not found' }
}

// spec: {model(原始 id), prompt, cwd}
export function complete(ctx, spec, io) {
  const t0 = nowMs()
  return new Promise((resolve, reject) => {
    let firstAt = 0
    const mark = () => { if (!firstAt) firstAt = nowMs() }
    const parser = createParser({ onText: (t) => { mark(); io.onText?.(t) }, onReasoning: (t) => { mark(); io.onReasoning?.(t) } })
    let done = false
    const settle = (st) => {
      if (done) return
      done = true
      io.signal?.removeEventListener('abort', onAbort)
      const r = parser.result
      if (st.killed && io.signal?.aborted) return reject(Object.assign(new Error('已取消'), { code: 'aborted' }))
      if (!r || r.is_error) return reject(providerError(r?.result || st.stderr || `cursor-agent 退出（${st.code ?? st.signal}）`))
      resolve({ text: parser.text || r.result || '', reasoning: parser.reasoning, nativeModel: spec.model, usage: usageOf(r), ttftMs: firstAt ? firstAt - t0 : undefined, agentMs: r.duration_ms, ms: nowMs() - t0, toolUses: parser.toolCalls })
    }
    const proc = startProc('cursor-agent', buildArgs(spec), {
      env: ctx.env, cwd: spec.cwd, stdin: 'ignore',
      // result 就返回，不等进程收尾
      onLine: (l) => { parser.feed(l); if (parser.result) { settle({ killed: false }); setTimeout(() => proc.kill(), 10000).unref?.() } },
      onExit: settle,
    })
    const onAbort = () => proc.kill()
    if (io.signal?.aborted) return onAbort()
    io.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const AUTH = /not logged in|login|unauthori|authenticat|api key|keychain/i
export function providerError(msg) {
  const m = String(msg || 'cursor-agent failed').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().slice(-600)
  return Object.assign(new Error(`cursor-agent: ${m}`), { code: AUTH.test(m) ? 'auth' : 'provider' })
}

export const cheapest = (models) => (models.find((m) => /composer.*fast/.test(m.model)) || models.find((m) => CHEAP.test(m.model)) || models[0])
