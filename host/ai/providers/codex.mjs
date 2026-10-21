// Codex 提供方：codex exec --json --ephemeral，只读沙箱，不读用户 config.toml（那里有一堆 MCP / 插件 / hooks），
// 再显式关掉 hooks、apps、插件、浏览器、电脑操控、生图、子 agent 和 shell，等于一个纯对话模型。
// 图片写临时文件用 -i；结构化输出 --output-schema；推理等级 -c model_reasoning_effort=…
// 限制：exec --json 没有逐字增量，一条消息完整生成后才出来（onChunk 一次给整段）
import fs from 'node:fs'
import path from 'node:path'
import { startProc, nowMs } from '../proc.mjs'
import { run, HOME } from '../env.mjs'

const DISABLE = ['hooks', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'shell_tool', 'unified_exec']
const CHEAP = /mini|nano|lite|luna|small|flash|low/i

export function buildArgs({ model, effort, cwd, imageFiles = [], schemaFile, toolArgs = [] }) {
  return [
    'exec',
    // -i 收多个值：放最前面，后面紧跟别的选项，免得把提示也当成图片
    ...imageFiles.flatMap((f) => ['-i', f]),
    '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only',
    ...DISABLE.flatMap((f) => ['--disable', f]),
    '-c', 'mcp_servers={}', ...toolArgs,
    '-c', 'approval_policy="never"',
    // 不带 ~/.codex/AGENTS.md 这类说明文件（它们是给写代码用的）
    '-c', 'project_doc_max_bytes=0',
    ...(model ? ['-m', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-C', cwd,
    '-', // 提示从 stdin 读
  ]
}

// 解析 exec --json 的事件。cb: onText / onReasoning / onTool
export function createParser(cb = {}) {
  const st = { text: '', reasoning: '', usage: null, error: '', toolCalls: [], done: false }
  st.feed = (line) => {
    let e
    try { e = JSON.parse(line) } catch { return }
    const it = e.item || {}
    if (e.type === 'item.completed' && it.type === 'agent_message' && it.text) {
      const t = st.text ? `\n\n${it.text}` : it.text
      st.text += t
      cb.onText?.(t)
    } else if (e.type === 'item.completed' && it.type === 'reasoning' && it.text) {
      const t = st.reasoning ? `\n\n${it.text}` : it.text
      st.reasoning += t
      cb.onReasoning?.(t)
    } else if (e.type === 'item.started' && it.type === 'mcp_tool_call') {
      st.toolCalls.push({ name: it.tool, input: it.arguments })
      cb.onTool?.({ name: it.tool, input: it.arguments })
    } else if (e.type === 'turn.completed') {
      st.usage = e.usage || {}
      st.done = true
    } else if (e.type === 'turn.failed') st.error = e.error?.message || 'turn failed'
    else if (e.type === 'error') st.error = e.message || 'error'
  }
  return st
}

export function usageOf(u = {}) {
  return {
    inputTokens: u.input_tokens || 0,
    cachedInputTokens: u.cached_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    reasoningTokens: u.reasoning_output_tokens || 0,
  }
}

// 账号可用的模型：~/.codex/models_cache.json 里 visibility=list 的
export function readModels(file = path.join(HOME, '.codex/models_cache.json')) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))
  const ms = (Array.isArray(d) ? d : d.models || []).filter((m) => m && (m.visibility || 'list') === 'list' && (m.slug || m.id))
  return ms.map((m) => {
    const slug = m.slug || m.id
    return {
      model: slug,
      label: m.display_name || slug,
      efforts: (m.supported_reasoning_levels || []).map((x) => x.effort || x).filter((x) => typeof x === 'string'),
      defaultEffort: m.default_reasoning_level,
      vision: (m.input_modalities || ['text', 'image']).includes('image'),
      tier: CHEAP.test(slug) ? 'fast' : /sol|max|pro/i.test(slug) ? 'strong' : 'balanced',
      priority: m.priority,
    }
  })
}

export async function available(env) {
  const r = await run('codex', ['login', 'status'], { env, timeout: 15000 })
  return r.code === 0 && /logged in/i.test(r.out + r.err) ? { ok: true } : { ok: false, reason: (r.err || r.out || 'codex not found').trim().slice(0, 200) }
}

// spec: {model, effort, prompt, imageFiles, schemaFile, toolArgs, cwd}
export function complete(ctx, spec, io) {
  const t0 = nowMs()
  return new Promise((resolve, reject) => {
    let firstAt = 0
    const mark = () => { if (!firstAt) firstAt = nowMs() }
    const parser = createParser({
      onText: (t) => { mark(); io.onText?.(t) },
      onReasoning: (t) => { mark(); io.onReasoning?.(t) },
      onTool: io.onTool,
    })
    let done = false
    const settle = (st) => {
      if (done) return
      done = true
      io.signal?.removeEventListener('abort', onAbort)
      if (st.killed && io.signal?.aborted) return reject(Object.assign(new Error('已取消'), { code: 'aborted' }))
      if (parser.error || !parser.done) return reject(providerError(parser.error || st.stderr || `codex 退出（${st.code ?? st.signal}）`))
      resolve({ text: parser.text, reasoning: parser.reasoning, nativeModel: spec.model, usage: usageOf(parser.usage), ttftMs: firstAt ? firstAt - t0 : undefined, ms: nowMs() - t0, toolUses: parser.toolCalls })
    }
    const proc = startProc('codex', buildArgs(spec), {
      env: ctx.env, cwd: spec.cwd,
      // turn.completed 就返回，不等进程收尾
      onLine: (l) => { parser.feed(l); if (parser.done) { settle({ killed: false }); setTimeout(() => proc.kill(), 10000).unref?.() } },
      onExit: settle,
    })
    const onAbort = () => proc.kill()
    if (io.signal?.aborted) return onAbort()
    io.signal?.addEventListener('abort', onAbort, { once: true })
    proc.write(spec.prompt)
    proc.end()
  })
}

const AUTH = /not logged in|login|unauthori|authenticat|401|api key/i
export function providerError(msg) {
  const m = String(msg || 'codex failed').replace(/\x1b\[[0-9;]*m/g, '').replace(/Reading additional input from stdin\.\.\.\s*/g, '').trim().slice(-600)
  return Object.assign(new Error(`codex: ${m}`), { code: AUTH.test(m) ? 'auth' : 'provider' })
}
