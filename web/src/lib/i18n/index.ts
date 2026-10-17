// 界面语言：中文原文就是 key，英文字典按文件分组放在 en/ 下（每个文件 export default { 中文: English }）。
// 语言在启动时定一次（手机里手动选过的优先，否则跟随系统语言），切换后刷新页面，所以模块里的常量文案也能翻译。
//   t('已发送 {n} 条', { n })  界面自己的文案
//   tr(msg)                     服务端 / 电脑那边发来的提示：先整句匹配，再按带 {占位} 的条目做模式匹配，都没有就原样显示
export type Lang = 'zh' | 'en'
const LANG_KEY = 'lang'
const modules = import.meta.glob<{ default: Record<string, string> }>('./en/*.ts', { eager: true })
const EN: Record<string, string> = Object.assign({}, ...Object.values(modules).map((m) => m.default))
// tr() 的模式匹配只用服务端 / 电脑那边消息的字典，免得界面自己的短模板（「定时 {n}」之类）误套到服务端消息上
const REMOTE = /\/(server|mac|preview-agent)\.ts$/
const REMOTE_EN: Record<string, string> = Object.assign({}, ...Object.entries(modules).filter(([p]) => REMOTE.test(p)).map(([, m]) => m.default))

function detect(): Lang {
  try { const v = localStorage.getItem(LANG_KEY); if (v === 'zh' || v === 'en') return v } catch {}
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || '']
  return langs.some((l) => /^zh\b/i.test(l)) ? 'zh' : 'en'
}
export const lang: Lang = detect()
export const isEn = lang === 'en'
if (typeof document !== 'undefined') document.documentElement.lang = isEn ? 'en' : 'zh-CN'
// 让 service worker 也知道（推送通知标题要翻）
try { caches.open('pane-lang').then((c) => c.put('lang', new Response(lang))).catch(() => {}) } catch {}

export function setLang(l: Lang) {
  try { localStorage.setItem(LANG_KEY, l) } catch {}
  location.reload()
}

function fill(s: string, vars?: Record<string, unknown>) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s
}
export function t(zh: string, vars?: Record<string, unknown>): string {
  return fill(isEn ? (EN[zh] ?? zh) : zh, vars)
}

let patterns: { re: RegExp; names: string[]; en: string }[] | null = null
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function buildPatterns() {
  patterns = Object.entries(REMOTE_EN).filter(([k]) => /\{\w+\}/.test(k)).map(([k, en]) => {
    const names: string[] = []
    const src = k.split(/(\{\w+\})/).map((part) => {
      const m = part.match(/^\{(\w+)\}$/)
      if (m) { names.push(m[1]); return '([\\s\\S]*?)' }
      return escRe(part)
    }).join('')
    return { re: new RegExp(`^${src}$`), names, en }
  })
  // 长的模板优先，免得短模板把长句吞掉
  patterns.sort((a, b) => b.re.source.length - a.re.source.length)
}
export function tr(msg: string | null | undefined): string {
  if (!msg || !isEn) return msg ?? ''
  if (EN[msg]) return EN[msg]
  if (!patterns) buildPatterns()
  for (const p of patterns!) {
    const m = msg.match(p.re)
    if (m) return fill(p.en, Object.fromEntries(p.names.map((n, i) => [n, tr(m[i + 1])])))
  }
  return msg
}
