// 本机 AI 提供方：把 Claude Code、Codex、cursor-agent 合成一个模型列表，实现 whatevertools 的 AiCapability
//   models()                         → [{ id, label, icon, vision, provider, efforts, tier, structured, tools, … }]
//   complete({ model, messages, tools }, { onChunk, callTool, signal }) → AiMessage
//   completeAdvanced(req, io)        → { message, text, reasoning, structured, usage, ttftMs, ms, … }（platform.ai 的底层）
// 模型 ID：<提供方>/<模型>[@推理等级]，如 claude/sonnet@high、codex/gpt-5.6-luna@low、cursor/composer-2.5-fast
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentEnv, STATE } from './env.mjs'
import { normalize, resolveImages, hasImages, images, toText, extension } from './messages.mjs'
import { startToolBridge } from './toolbridge.mjs'
import * as claude from './providers/claude.mjs'
import * as codex from './providers/codex.mjs'
import { createCodexHome } from './codex-home.mjs'
import * as cursor from './providers/cursor.mjs'

const DAY = 86400000
const PROVIDERS = ['claude', 'codex', 'cursor']
const ICON_COLOR = { claude: '#d97757', codex: '#10a37f', cursor: '#111111' }
const ICON_TEXT = { claude: 'C', codex: 'X', cursor: 'Cu' }
export const icon = (p) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ICON_COLOR[p]}"/><text x="16" y="21.5" font-family="-apple-system,Helvetica,Arial" font-size="${ICON_TEXT[p].length > 1 ? 13 : 16}" font-weight="700" fill="#fff" text-anchor="middle">${ICON_TEXT[p]}</text></svg>`)

const CODEX_PREAMBLE = 'This is a plain chat request, not a coding task: do not inspect files or run commands. Unless the instructions below say otherwise, reply in the language of the user message.\n\n'
const BRIDGE_PROMPT = 'Describe each attached image in detail for a reader who cannot see it: layout, objects, people, colors, charts and UI elements. Then transcribe ALL visible text verbatim (OCR), keeping line breaks. Format for each image:\n### Image N\nDescription: ...\nText:\n...\nIf an image has no text write "Text: (none)". Do not add commentary.'

// 「model@effort」拆开
export function splitModelId(id) {
  const s = String(id || '')
  const at = s.lastIndexOf('@')
  return at > 0 ? { base: s.slice(0, at), effort: s.slice(at + 1) } : { base: s, effort: '' }
}

// 把模型列表里的一项 + 推理等级 解析成提供方的原生模型 ID
export function resolveModel(list, id) {
  const { base, effort } = splitModelId(id)
  let entry = list.find((m) => m.id === base)
  let native
  if (!entry) {
    const [prov, ...rest] = base.split('/')
    const name = rest.join('/')
    if (prov === 'cursor') {
      entry = list.find((m) => m.provider === 'cursor' && m.raw?.includes(name))
      if (entry) native = name
    } else if (prov === 'claude' && /^claude-[\w.-]+$/.test(name)) {
      entry = { ...(list.find((m) => m.provider === 'claude') || {}), id: base, provider: 'claude', model: name, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
    } else if (prov === 'codex' && /^[\w.-]+$/.test(name)) {
      entry = list.find((m) => m.provider === 'codex' && m.model === name)
    }
    if (!entry?.provider) throw Object.assign(new Error(`没有这个模型：${id}`), { code: 'model' })
  }
  if (effort && !(entry.efforts || []).includes(effort)) throw Object.assign(new Error(`${entry.id} 不支持推理等级 ${effort}（可选：${(entry.efforts || []).join(' / ') || '无'}）`), { code: 'model' })
  const eff = effort || entry.defaultEffort || ''
  if (!native) native = entry.provider === 'cursor' ? entry.variants[eff] || entry.variants[''] || entry.raw[0] : entry.model
  return { entry, effort: entry.provider === 'cursor' ? '' : effort, native }
}

// responseFormat：OpenAI 的 {type:'json_schema', json_schema:{schema}}、{type:'json_schema', schema} 或直接一个 JSON Schema
export function schemaOf(rf) {
  if (!rf) return null
  if (rf.type === 'json_schema') return rf.json_schema?.schema || rf.schema || null
  if (rf.type === 'json_object') return { type: 'object' }
  return typeof rf === 'object' ? rf : null
}

export function parseJson(text) {
  const s = String(text || '').trim()
  try { return JSON.parse(s) } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
  if (fence) try { return JSON.parse(fence[1]) } catch {}
  const m = /[[{][\s\S]*[\]}]/.exec(s)
  if (m) try { return JSON.parse(m[0]) } catch {}
  return undefined
}

export function createAi(opts = {}) {
  const env = agentEnv(opts)
  const cacheDir = opts.cacheDir || path.join(STATE, 'ai')
  // 空工作目录，放在家目录外面：Claude Code 会沿父目录找 CLAUDE.md，工作目录在 ~ 下面会把 ~/.claude/CLAUDE.md
  // （用户自己的全局说明，几千 token）当成项目说明带进去
  const workDir = opts.workDir || path.join(os.tmpdir(), 'pane-remote-ai-work')
  fs.mkdirSync(workDir, { recursive: true })
  const enabled = opts.providers || PROVIDERS
  const pool = new claude.WarmPool({ env, cwd: workDir })
  const ctx = { env, pool }
  // Codex 用单独的 CODEX_HOME（不带 ~/.codex/AGENTS.md，登录共用，见 codex-home.mjs）；codexHome: false 关掉
  const codexHome = opts.codexHome === false ? null : createCodexHome({ dir: opts.codexHome || path.join(STATE, 'codex-home'), home: os.homedir() })
  const codexEnv = () => (codexHome ? codexHome.env(env) : env)
  const describeCache = new Map() // 图片哈希 → 转译文字（多轮对话里同一张图只转一次）
  let memo = null

  async function listModels({ refresh = false } = {}) {
    const file = path.join(cacheDir, 'models.json')
    if (!refresh && memo && Date.now() - memo.t < DAY) return memo.models
    if (!refresh) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Date.now() - d.t < DAY && d.providers === enabled.join(',')) { memo = d; return d.models }
      } catch {}
    }
    const skipped = {}
    const parts = await Promise.all(enabled.map(async (p) => {
      try {
        const a = p === 'codex' ? await codex.available(codexEnv()).finally(() => codexHome?.reconcile()) : await { claude, cursor }[p].available(env)
        if (!a.ok) { skipped[p] = a.reason; return [] }
        if (p === 'claude') return claude.MODELS.map((m) => ({ ...m, vision: true, structured: true, tools: true }))
        if (p === 'codex') return codex.readModels().map((m) => ({ ...m, structured: true, tools: 'experimental' }))
        return cursor.parseModels(await cursor.listRaw(env)).map((m) => ({ ...m, vision: 'bridged', structured: 'prompt', tools: false }))
      } catch (e) { skipped[p] = String(e.message || e).slice(0, 200); return [] }
    }))
    const models = parts.flatMap((ms, i) => ms.map((m) => ({ id: `${enabled[i]}/${m.model}`, provider: enabled[i], icon: icon(enabled[i]), ...m, label: enabled[i] === 'cursor' ? `${m.label} (Cursor)` : m.label })))
    memo = { t: Date.now(), providers: enabled.join(','), models, skipped }
    // 某家暂时登录不了时不缓存一整天，下次再试
    if (!Object.keys(skipped).length) {
      try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(memo)) } catch {}
    }
    return models
  }

  // whatevertools 的 models()：必填字段 + 额外信息（provider / efforts / tier / structured / tools / vision:'bridged'）
  async function models(o) {
    return (await listModels(o)).map(({ variants, raw, priority, ...m }) => m)
  }

  function defaultModel(list) {
    return opts.defaultModel || list.find((m) => m.id === 'claude/sonnet')?.id || list.find((m) => m.tier === 'balanced')?.id || list[0]?.id
  }

  // 看图模型：claude/haiku 优先，没有就用 Codex 最轻的
  function bridgeModel(list) {
    if (opts.visionBridge) return opts.visionBridge
    if (list.some((m) => m.id === 'claude/haiku')) return 'claude/haiku'
    const c = list.find((m) => m.provider === 'codex' && m.vision && m.tier === 'fast')
    if (c) return `${c.id}@${c.efforts?.includes('low') ? 'low' : c.defaultEffort}`
    return list.find((m) => m.vision === true)?.id
  }

  // 不能原生看图的模型：先用看图模型把所有图片转成「描述 + OCR 文字」，替换成文字块
  async function bridgeImages(norm, list, signal) {
    const imgs = images(norm)
    const keyOf = (p) => crypto.createHash('sha256').update(p.data).digest('hex')
    const todo = imgs.filter((p) => !describeCache.has(keyOf(p)))
    const model = bridgeModel(list)
    const info = { model, ms: 0, images: imgs.length, cached: imgs.length - todo.length }
    if (todo.length) {
      if (!model) throw Object.assign(new Error('没有能看图的模型，没法转译图片'), { code: 'vision' })
      const content = todo.flatMap((p, i) => [{ type: 'text', text: `Image ${i + 1}:` }, { type: 'image_url', image_url: { url: `data:${p.mediaType || 'image/png'};base64,${p.data}` } }])
      const r = await completeAdvanced({ model, messages: [{ role: 'system', content: 'You convert images to precise text descriptions.' }, { role: 'user', content: [...content, { type: 'text', text: BRIDGE_PROMPT }] }] }, { signal })
      info.ms = r.ms
      info.usage = r.usage
      const sections = r.text.split(/^### Image\s+(\d+)\s*$/m)
      todo.forEach((p, i) => {
        const at = sections.indexOf(String(i + 1))
        describeCache.set(keyOf(p), at >= 0 ? sections[at + 1].trim() : r.text.trim())
      })
      while (describeCache.size > 200) describeCache.delete(describeCache.keys().next().value)
    }
    let n = 0
    for (const t of norm.turns) {
      t.parts = t.parts.map((p) => (p.type !== 'image' ? p : { type: 'text', text: `[Image ${++n}, converted to text by ${model} because this model cannot see images]\n${describeCache.get(keyOf(p))}\n[End of image ${n}]` }))
    }
    return info
  }

  async function completeAdvanced(req = {}, io = {}) {
    const tStart = Date.now()
    const list = await listModels()
    if (!list.length) throw Object.assign(new Error('本机没有可用的 AI 提供方（Claude Code / Codex / cursor-agent 都没登录）'), { code: 'unavailable' })
    const reqModel = req.model || defaultModel(list)
    const reasoning = typeof req.reasoning === 'string' ? req.reasoning : req.reasoning?.effort
    const { entry, effort, native } = resolveModel(list, reasoning && !splitModelId(reqModel).effort ? `${reqModel}@${reasoning}` : reqModel)
    const schema = schemaOf(req.responseFormat)
    const tools = Array.isArray(req.tools) && req.tools.length ? req.tools : null
    if (tools && !entry.tools) throw Object.assign(new Error(`${entry.id} 不支持工具调用`), { code: 'tools' })

    // 超时 + 外部取消
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), req.timeoutMs || opts.timeoutMs || 300000)
    const onOuter = () => ac.abort()
    if (io.signal?.aborted) ac.abort()
    io.signal?.addEventListener('abort', onOuter, { once: true })
    const signal = ac.signal

    const chunk = (c) => { try { io.onChunk?.(c) } catch {} }
    const pio = {
      signal,
      onText: (t) => chunk({ role: 'assistant', content: t }),
      onReasoning: (t) => chunk({ role: 'assistant', content: '', reasoning_content: t }),
      onTool: (t) => { try { io.onEvent?.({ type: 'tool', ...t }) } catch {} },
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-ai-req-'))
    let tb = null
    try {
      const norm = await resolveImages(normalize(req.messages), { signal })
      if (!norm.turns.length) throw Object.assign(new Error('messages 里没有用户消息'), { code: 'input' })
      let bridge
      if (hasImages(norm) && entry.vision !== true) bridge = await bridgeImages(norm, list, signal)
      if (tools) tb = await startToolBridge(tools, { callTool: io.callTool, onCall: (c) => { try { io.onEvent?.({ type: 'tool-call', ...c }) } catch {} } })
      let r
      if (entry.provider === 'claude') {
        r = await claude.complete(ctx, { model: native, effort, system: norm.system, norm, schema, mcpConfig: tb?.claudeConfig(), warm: opts.warm !== false && !tb }, pio)
      } else if (entry.provider === 'codex') {
        const imageFiles = images(norm).map((p, i) => {
          const f = path.join(tmp, `image-${i + 1}.${extension(p.mediaType)}`)
          fs.writeFileSync(f, Buffer.from(p.data, 'base64'))
          return f
        })
        let schemaFile
        if (schema) { schemaFile = path.join(tmp, 'schema.json'); fs.writeFileSync(schemaFile, JSON.stringify(schema)) }
        const body = toText(norm, (_, n) => `[attached image ${n}]`)
        // 独立的 CODEX_HOME 已经不带 ~/.codex/AGENTS.md；关掉独立目录时它还在（可能规定了回答语言），这句留着
        const prompt = `${CODEX_PREAMBLE}${norm.system ? `<instructions>\n${norm.system}\n</instructions>\n\n` : ''}${body}`
        r = await codex.complete({ ...ctx, env: codexEnv() }, { model: native, effort, prompt, imageFiles, schemaFile, toolArgs: tb ? tb.codexArgs() : [], cwd: workDir }, pio).finally(() => codexHome?.reconcile())
      } else {
        const fmt = schema ? `\n\nReply with ONLY one JSON value (no prose, no code fence) that validates against this JSON Schema:\n${JSON.stringify(schema)}` : ''
        const prompt = `${cursor.NO_TOOLS}\n\n${norm.system ? `<instructions>\n${norm.system}\n</instructions>\n\n` : ''}${toText(norm)}${fmt}`
        r = await cursor.complete(ctx, { model: native, prompt, cwd: workDir }, pio)
      }
      let structured
      if (schema) {
        structured = r.structured !== undefined ? r.structured : parseJson(r.text)
        if (structured === undefined) throw Object.assign(new Error(`${entry.id} 没有返回合法的 JSON`), { code: 'structured', text: r.text })
      }
      const message = { role: 'assistant', content: r.text }
      if (r.reasoning) message.reasoning_content = r.reasoning
      return {
        message, text: r.text, reasoning: r.reasoning, structured,
        model: entry.id + (effort ? `@${effort}` : ''), provider: entry.provider, nativeModel: r.nativeModel || native, effort,
        // ttftMs / ms 只算目标模型这一次（含进程启动）；totalMs 含图片转译、下载等全部时间
        usage: r.usage, ttftMs: r.ttftMs, ms: r.ms, totalMs: Date.now() - tStart, agentTtftMs: r.agentTtftMs, warm: r.warm,
        toolCalls: tb ? tb.calls.map(({ name, args, ms, error }) => ({ name, args, ms, error })) : [],
        bridge,
      }
    } catch (e) {
      if (signal.aborted && !io.signal?.aborted && e.code === 'aborted') throw Object.assign(new Error('超时'), { code: 'timeout' })
      throw e
    } finally {
      clearTimeout(timeout)
      io.signal?.removeEventListener('abort', onOuter)
      tb?.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  async function complete(req, io = {}) {
    return (await completeAdvanced(req, io)).message
  }

  return { models, listModels, complete, completeAdvanced, close: () => pool.close(), get skipped() { return memo?.skipped || {} } }
}
