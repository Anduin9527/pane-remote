// 从一行带转义序列的终端文字里，找出某一列上的链接：先看 OSC 8 超链接（Claude Code 输出的链接是这种），再看纯文本里的网址 / localhost / 本机文件路径
const wide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)

// 文件路径认这些扩展名（网页、图片、文档、常见代码），预览的文件浏览器都能显示
const FILE_EXT = 'html?|svg|png|jpe?g|gif|webp|pdf|md|mdx|txt|log|json|ya?ml|toml|csv|tsv|[cm]?[jt]sx?|svelte|vue|css|scss|py|go|rs|rb|java|kt|swift|sh|sql|mp4|mov|mp3'
// 第 4 组：相对路径（./x、../x 或带一层以上目录的 a/b.ts），按会话所在目录解析
const TEXT_LINK = new RegExp(
  "(https?:\\/\\/[^\\s<>\"'`│]+[^\\s<>\"'`│.,;:!?)\\]}])|((?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):\\d{2,5}[^\\s\"'`│]*)" +
  `|((?:~|\\/Users|\\/tmp|\\/private)\\/[^\\s"'\`│:]+\\.(?:${FILE_EXT}))(?![\\w/])` +
  `|((?<![\\w/~.-])(?:\\.{1,2}\\/)?(?:[\\w@.-]+\\/)+[\\w@.-]+\\.(?:${FILE_EXT}))(?![\\w/])`,
  'g',
)

/**
 * 链接 → 预览能打开的地址。网址原样；本机绝对路径（~/、/）去掉行号；相对路径按 base（会话所在目录，绝对路径）拼成绝对路径。
 * 打不开的（mailto:、页内锚点、没有 base 的相对路径）返回 null
 */
export function resolveLink(href: string, base?: string | null): string | null {
  let h = href.trim()
  if (/^(https?|file):/i.test(h)) return h
  if (!h || h.startsWith('#') || h.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(h)) {
    // localhost:3000 这种没写协议的，交给预览补 http://
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d/.test(h) ? h : null
  }
  h = h.split('#')[0].replace(/:\d+(:\d+)?$/, '') // 去掉 #L12、:12:5 这种行号
  try { h = decodeURI(h) } catch {}
  if (h.startsWith('~/') || h === '~' || h.startsWith('/')) return h
  if (!base) return null
  const parts = base.replace(/\/+$/, '').split('/')
  for (const seg of h.split('/')) {
    if (seg === '..') { if (parts.length > 1) parts.pop() }
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/') || '/'
}

export function linkAt(raw: string, col: number): string | null {
  let c = 0
  let link = ''
  let plain = ''
  const colOf: number[] = [] // plain 里每个字符的起始列
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\x1b') {
      const n = raw[i + 1]
      if (n === '[') { // CSI
        let j = i + 2
        while (j < raw.length && !/[@-~]/.test(raw[j])) j++
        i = j + 1
        continue
      }
      if (n === ']') { // OSC，以 BEL 或 ESC \ 结束
        let j = i + 2
        let end = -1, stLen = 1
        for (; j < raw.length; j++) {
          if (raw[j] === '\x07') { end = j; break }
          if (raw[j] === '\x1b' && raw[j + 1] === '\\') { end = j; stLen = 2; break }
        }
        const body = raw.slice(i + 2, end < 0 ? raw.length : end)
        const m = body.match(/^8;[^;]*;(.*)$/)
        if (m) link = m[1]
        i = end < 0 ? raw.length : end + stLen
        continue
      }
      i += 2
      continue
    }
    const cp = raw.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const w = wide(cp) ? 2 : 1
    if (link && col >= c && col < c + w) return link
    colOf.push(c)
    plain += raw.slice(i, i + len)
    if (len === 2) colOf.push(c)
    c += w
    i += len
  }
  for (const m of plain.matchAll(TEXT_LINK)) {
    const s = colOf[m.index!] ?? 0
    const e = (colOf[m.index! + m[0].length - 1] ?? s) + 1
    if (col >= s && col <= e) return m[0]
  }
  return null
}
