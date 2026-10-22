// 极简的版本范围判断（插件描述文件里 paneRemote.requires 用）：支持 1.2.3、>=1.2.3、>1.2.3、<=、<、^1.2.3、~1.2.3，空格分开表示同时满足
const parse = (v) => { const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(v).trim()); return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null }
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

export function satisfies(version, range) {
  const v = parse(version)
  if (!v) return false
  const parts = String(range || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return false
  return parts.every((p) => {
    const m = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(p)
    const r = m && parse(m[2])
    if (!r) return false
    const c = cmp(v, r)
    switch (m[1]) {
      case '>=': return c >= 0
      case '>': return c > 0
      case '<=': return c <= 0
      case '<': return c < 0
      // ^：主版本不变（0.x 时次版本不变），和 npm 一样
      case '^': return c >= 0 && (r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : v[0] === 0 && v[1] === 0 && v[2] === r[2])
      case '~': return c >= 0 && v[0] === r[0] && v[1] === r[1]
      default: return c === 0
    }
  })
}
export const validRange = (range) => typeof range === 'string' && range.trim().split(/\s+/).every((p) => /^(>=|<=|>|<|\^|~|=)?v?\d+(\.\d+){0,2}$/.test(p))
