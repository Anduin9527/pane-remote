// Claude Code 提供方：claude -p，stream-json 进 / stream-json 出（带逐字增量），不给内置工具、不加载 hooks / MCP /
// 用户设置 / 技能，不留会话。注意：不能用 --bare（它跳过钥匙串里的登录，订阅账号就用不了了）。
// 「常驻」：stream-json 输入模式下进程启动后会等 stdin，所以可以按同一组参数预先起一个备用进程；
// 下一次同参数的请求直接把消息写进去，省掉 2 秒左右的启动。一个进程只答一次（不复用上下文），答完马上补一个备用的
import { startProc, nowMs } from '../proc.mjs'
import { run } from '../env.mjs'
import { toClaudeContent } from '../messages.mjs'

export const DEFAULT_SYSTEM = 'You are a helpful assistant. Answer directly.'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const MODELS = [
  { model: 'opus', label: 'Claude Opus', tier: 'strong', efforts: EFFORTS },
  { model: 'fable', label: 'Claude Fable', tier: 'strong', efforts: EFFORTS },
  { model: 'sonnet', label: 'Claude Sonnet', tier: 'balanced', efforts: EFFORTS },
  { model: 'haiku', label: 'Claude Haiku', tier: 'fast', efforts: [] },
]

export function buildArgs({ model, effort, system, schema, mcpConfig }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--model', model,
    '--system-prompt', system || DEFAULT_SYSTEM,
    // 只读项目级设置（工作目录是空目录，等于什么都不加载）；MCP 只认 --mcp-config 给的；内置工具一个不给
    '--setting-sources', 'project', '--strict-mcp-config', '--tools', '',
    '--no-session-persistence', '--disable-slash-commands',
    ...(effort ? ['--effort', effort] : []),
    ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
    // 临时 MCP 的工具全部放行（-p 模式下没放行的工具会被直接拒绝）
    ...(mcpConfig ? ['--mcp-config', mcpConfig, '--allowedTools', 'mcp__wt'] : []),
  ]
}

export const userLine = (norm) => ({ type: 'user', message: { role: 'user', content: toClaudeContent(norm) } })

// 解析 stream-json 输出。cb: onText(delta) / onReasoning(delta) / onTool({name, input})
export function createParser(cb = {}) {
  const st = { text: '', reasoning: '', model: '', result: null, toolUses: [], sawDelta: false, lastMsg: '' }
  st.feed = (line) => {
    let e
    try { e = JSON.parse(line) } catch { return }
    if (e.type === 'system' && e.subtype === 'init') st.model = e.model || st.model
    else if (e.type === 'stream_event') {
      const ev = e.event || {}
      if (ev.type === 'message_start') {
        // 工具调用后的下一条回复：和前面的文字隔一个空行
        if (st.text && ev.message?.id !== st.lastMsg) st.pendingSep = true
        st.lastMsg = ev.message?.id || st.lastMsg
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {}
        if (d.type === 'text_delta' && d.text) {
          st.sawDelta = true
          const t = st.pendingSep ? `\n\n${d.text}` : d.text
          st.pendingSep = false
          st.text += t
          cb.onText?.(t)
        } else if (d.type === 'thinking_delta' && d.thinking) {
          st.reasoning += d.thinking
          cb.onReasoning?.(d.thinking)
        }
      }
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) {
        if (b.type === 'tool_use') { st.toolUses.push({ name: b.name, input: b.input }); cb.onTool?.({ name: b.name, input: b.input }) }
      }
      // 没开增量（或增量丢了）时用整条消息兜底
      if (!st.sawDelta) {
        const t = (e.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
        if (t) { const s = st.text ? `\n\n${t}` : t; st.text += s; cb.onText?.(s) }
      }
    } else if (e.type === 'result') {
      st.result = e
      cb.onResult?.(e)
    }
  }
  return st
}

export function usageOf(r) {
  const u = r?.usage || {}
  return {
    inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    cachedInputTokens: u.cache_read_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    reasoningTokens: u.output_tokens_details?.thinking_tokens || 0,
    costUsd: r?.total_cost_usd,
  }
}

export async function available(env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true }
  const r = await run('claude', ['auth', 'status'], { env, timeout: 15000 })
  try { const d = JSON.parse(r.out); return d.loggedIn ? { ok: true } : { ok: false, reason: 'not logged in' } } catch {}
  return { ok: false, reason: (r.err || r.out || 'claude not found').trim().slice(0, 200) }
}

// 备用进程池：key = 完整参数。每个 key 最多一个备用，闲置 10 分钟就杀掉
export class WarmPool {
  constructor({ env, cwd, ttl = 600000, max = 4 } = {}) { Object.assign(this, { env, cwd, ttl, max }); this.spares = new Map() }
  take(key) {
    const s = this.spares.get(key)
    if (!s) return null
    this.spares.delete(key)
    clearTimeout(s.timer)
    return s.proc.exited ? null : s
  }
  spawn(args, key, handlers) {
    // 备用进程启动时还没有请求：先把输出攒着，接手时一次性回放
    const pending = []
    const s = { key, handlers: null, pending }
    s.proc = startProc('claude', args, {
      env: this.env, cwd: this.cwd,
      onLine: (l) => (s.handlers ? s.handlers.onLine(l) : pending.push(l)),
      onExit: (st) => { if (s.handlers) s.handlers.onExit(st); else this.drop(key, s) },
    })
    if (handlers) this.attach(s, handlers)
    return s
  }
  attach(s, handlers) {
    s.handlers = handlers
    for (const l of s.pending.splice(0)) handlers.onLine(l)
    if (s.proc.exited) handlers.onExit(s.proc)
  }
  refill(args, key) {
    if (this.spares.has(key)) return
    if (this.spares.size >= this.max) { const [k, old] = this.spares.entries().next().value; this.drop(k, old); old.proc.kill() }
    const s = this.spawn(args, key)
    s.timer = setTimeout(() => { this.drop(key, s); s.proc.kill() }, this.ttl)
    s.timer.unref?.()
    this.spares.set(key, s)
  }
  drop(key, s) { if (this.spares.get(key) === s) { this.spares.delete(key); clearTimeout(s.timer) } }
  close() { for (const [k, s] of [...this.spares]) { this.drop(k, s); s.proc.kill() } }
}

// 跑一次。spec: {model, effort, system, norm, schema, mcpConfig, warm}；io: {onText, onReasoning, onTool, signal}
export function complete(ctx, spec, io) {
  const args = buildArgs(spec)
  const key = JSON.stringify(args)
  const t0 = nowMs()
  return new Promise((resolve, reject) => {
    let firstAt = 0
    const mark = () => { if (!firstAt) firstAt = nowMs() }
    const parser = createParser({
      onText: (t) => { mark(); io.onText?.(t) },
      onReasoning: (t) => { mark(); io.onReasoning?.(t) },
      onTool: io.onTool,
      // 拿到 result 就返回，不等进程退出（Claude Code 收尾还要 1~2 秒）；10 秒还没退就杀掉
      onResult: () => { settle({ killed: false }); setTimeout(() => slot?.proc.kill(), 10000).unref?.() },
    })
    let done = false
    const finish = (err, val) => {
      if (done) return
      done = true
      io.signal?.removeEventListener('abort', onAbort)
      err ? reject(err) : resolve(val)
    }
    const settle = (st) => {
      if (done) return
      const r = parser.result
      if (st.killed && io.signal?.aborted) return finish(Object.assign(new Error('已取消'), { code: 'aborted' }))
      if (!r) return finish(providerError(st.stderr || `claude 退出（${st.code ?? st.signal}）但没有给出结果`))
      if (r.is_error || r.subtype !== 'success') return finish(providerError(r.result || r.subtype || st.stderr, r))
      // 结构化输出不走文字增量：整段补一个 chunk，保证 onChunk 拼起来和返回的文字一致
      if (!parser.text && r.result) { mark(); io.onText?.(r.result) }
      finish(null, {
        text: parser.text || r.result || '',
        reasoning: parser.reasoning,
        structured: r.structured_output,
        nativeModel: parser.model,
        usage: usageOf(r),
        ttftMs: firstAt ? firstAt - t0 : undefined,
        agentTtftMs: r.ttft_ms,
        ms: nowMs() - t0,
        warm: !!slot?.warm,
        toolUses: parser.toolUses,
      })
    }
    let slot = null
    const handlers = { onLine: (l) => parser.feed(l), onExit: settle }
    const spare = spec.warm ? ctx.pool.take(key) : null
    if (spare) { slot = { proc: spare.proc, warm: true }; ctx.pool.attach(spare, handlers) } else slot = { proc: ctx.pool.spawn(args, key, handlers).proc, warm: false }
    const onAbort = () => slot.proc.kill()
    if (io.signal?.aborted) return onAbort()
    io.signal?.addEventListener('abort', onAbort, { once: true })
    slot.proc.write(userLine(spec.norm))
    slot.proc.end()
    if (spec.warm) ctx.pool.refill(args, key)
  })
}

const AUTH = /Not logged in|\/login|keychain|OAuth|authenticat|unauthori|invalid api key/i
export function providerError(msg, raw) {
  const m = String(msg || 'claude failed').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-600)
  return Object.assign(new Error(`claude: ${m}`), { code: AUTH.test(m) ? 'auth' : 'provider', raw })
}
