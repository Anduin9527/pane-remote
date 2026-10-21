// AI：把 host/ai（本机 Claude Code / Codex / cursor-agent 合成的模型列表）挂到 pane-host 的协议上。
//   ai.models {refresh?}                    call   → 模型列表（id/label/icon/vision/provider/efforts/tier/structured/tools…）
//   ai.complete {req, advanced?}            stream → 片段 {type: 'chunk', data: {role, content, reasoning_content?}}
//                                                    结束：advanced 为真回 completeAdvanced 的详细结果，否则只回 AiMessage
// 工具调用（req.tools）：agent 调工具时在流里发一个请求 {type: 'tool-call', rid, name, args}，
// 对端用通知 {method: 'reply', params: {id: 流的 id, rid, ok, value | error}} 回结果（见 main.mjs 的 ctx.request）。
// 第一次用到才建实例（建实例不起进程，只是省掉不用 AI 时的模型探测）；退出时 close() 杀掉常驻备用进程。
import { createAi } from '../ai/index.mjs'

const MAX_BODY = 15 << 20 // 请求里图片是 base64，协议单行上限 16MB

export function createAiService({ env = {} } = {}) {
  const providers = process.env.PANE_HOST_AI_PROVIDERS ? process.env.PANE_HOST_AI_PROVIDERS.split(',').filter(Boolean) : undefined
  let ai = null
  const get = () => (ai ??= createAi({ env, ...(providers ? { providers } : {}) }))
  const bad = (msg) => Object.assign(new Error(msg), { code: 'input' })

  return {
    calls: {
      'ai.models': async ({ refresh } = {}) => {
        const list = await get().models({ refresh: !!refresh })
        return { models: list, skipped: get().skipped }
      },
    },
    streams: {
      'ai.complete': async ({ req, advanced } = {}, ctx) => {
        if (!req || typeof req !== 'object' || !Array.isArray(req.messages)) throw bad('req.messages 要是数组')
        if (JSON.stringify(req).length > MAX_BODY) throw bad('请求太大（图片太多或太大）')
        const tools = Array.isArray(req.tools) && req.tools.length > 0
        const r = await get().completeAdvanced(req, {
          signal: ctx.signal,
          onChunk: (c) => ctx.chunk({ type: 'chunk', data: c }),
          callTool: tools ? (name, args) => ctx.request({ type: 'tool-call', name, args }) : undefined,
        })
        return advanced ? r : r.message
      },
    },
    close: () => ai?.close(),
  }
}
