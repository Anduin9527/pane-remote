// 把 whatevertools 的 AiMessage[]（OpenAI 风格，也兼容 Anthropic 风格的内容块）整理成各家都好用的形状：
//   system：所有 system 消息拼起来（Claude 走 --system-prompt，另两家放进提示开头）
//   turns：[{ role, parts: [{type:'text', text} | {type:'image', mediaType, data(base64)}] }]
// 三家 CLI 一次只吃一条输入，多轮历史压成一段对话记录，最后一条 user 消息是要回答的
export const IMAGE_MAX = 10 * 1024 * 1024

const DATA_URL = /^data:([\w.+/-]+);base64,(.*)$/s

function imagePart(src) {
  if (typeof src !== 'string') return null
  const m = DATA_URL.exec(src)
  if (m) return { type: 'image', mediaType: m[1], data: m[2] }
  if (/^https?:\/\//.test(src)) return { type: 'image', url: src }
  return null
}

function partsOf(content) {
  if (content == null) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }]
  const out = []
  for (const c of content) {
    if (typeof c === 'string') { out.push({ type: 'text', text: c }); continue }
    if (!c || typeof c !== 'object') continue
    if ((c.type === 'text' || c.type === 'input_text') && typeof c.text === 'string') out.push({ type: 'text', text: c.text })
    else if (c.type === 'image_url') {
      const p = imagePart(typeof c.image_url === 'string' ? c.image_url : c.image_url?.url)
      if (p) out.push(p)
    } else if (c.type === 'input_image') {
      const p = imagePart(c.image_url)
      if (p) out.push(p)
    } else if (c.type === 'image') {
      if (c.source?.type === 'base64') out.push({ type: 'image', mediaType: c.source.media_type, data: c.source.data })
      else if (c.source?.type === 'url') out.push({ type: 'image', url: c.source.url })
      else { const p = imagePart(c.image_url || c.image || c.url); if (p) out.push(p) }
    }
  }
  return out
}

export function normalize(messages) {
  const sys = []
  const turns = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const parts = partsOf(m.content)
    if (m.role === 'system') { sys.push(parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')); continue }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    if (parts.length) turns.push({ role, parts })
  }
  return { system: sys.filter(Boolean).join('\n\n'), turns }
}

export const images = (norm) => norm.turns.flatMap((t) => t.parts.filter((p) => p.type === 'image'))
export const hasImages = (norm) => images(norm).length > 0

// 网址图片先下载成 base64（三家 CLI 都只收本地数据 / 文件）
export async function resolveImages(norm, { signal } = {}) {
  for (const p of images(norm)) {
    if (p.data || !p.url) continue
    const r = await fetch(p.url, { signal })
    if (!r.ok) throw new Error(`下载图片失败 ${r.status}: ${p.url.slice(0, 120)}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > IMAGE_MAX) throw new Error('图片太大（超过 10MB）')
    p.mediaType = (r.headers.get('content-type') || 'image/png').split(';')[0]
    p.data = buf.toString('base64')
  }
  for (const p of images(norm)) if (Buffer.byteLength(p.data || '', 'base64') > IMAGE_MAX) throw new Error('图片太大（超过 10MB）')
  return norm
}

const single = (norm) => norm.turns.length === 1 && norm.turns[0].role === 'user'
const LABEL = { user: 'User', assistant: 'Assistant' }

// 拼成纯文本提示；图片用 imageText(part, 序号) 代替（Codex 写「见附图 N」，cursor 填转译出来的描述）
export function toText(norm, imageText = (_, n) => `[image ${n}]`) {
  let n = 0
  const render = (t) => t.parts.map((p) => (p.type === 'text' ? p.text : imageText(p, ++n))).join('\n')
  if (single(norm)) return render(norm.turns[0])
  const lines = norm.turns.map((t) => `<${LABEL[t.role]}>\n${render(t)}\n</${LABEL[t.role]}>`)
  return `The conversation so far is below. Write the next Assistant reply to the last User message. Reply with the message text only, without the <Assistant> tags.\n\n${lines.join('\n\n')}`
}

// Claude stream-json 输入的 content 块：图片原样作为 image 块，多轮时前后夹上角色标签
export function toClaudeContent(norm) {
  const block = (p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType || 'image/png', data: p.data } })
  if (single(norm)) return norm.turns[0].parts.map(block)
  const out = [{ type: 'text', text: 'The conversation so far is below. Write the next Assistant reply to the last User message. Reply with the message text only, without the <Assistant> tags.' }]
  for (const t of norm.turns) {
    out.push({ type: 'text', text: `<${LABEL[t.role]}>` })
    out.push(...t.parts.map(block))
    out.push({ type: 'text', text: `</${LABEL[t.role]}>` })
  }
  return out
}

export function extension(mediaType) {
  return { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType] || 'png'
}
