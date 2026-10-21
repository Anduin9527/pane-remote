// 审计：插件的每次能力调用记一行（谁、调了什么、权限结论、谁实现的、耗时、出错信息），不记参数内容。
// 内存里留最近 500 条给设置页看；同时追加到 audit.jsonl，超过 2MB 轮转成 audit.1.jsonl。
import fs from 'node:fs'
import path from 'node:path'

const KEEP = 500
const ROTATE = 2 << 20

export function createAudit(file) {
  const recent = []
  let size = 0
  if (file) try { size = fs.statSync(file).size } catch {}
  function write(line) {
    if (!file) return
    try {
      if (size > ROTATE) { fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl')); size = 0 }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line, { mode: 0o600 })
      size += Buffer.byteLength(line)
    } catch (e) { console.log(`plugins: audit write ${e.message}`) }
  }
  return {
    /** e: { plugin, method, result: 'ok'|'denied'|'unsupported'|'error'|'delegated', impl, ms, error? } */
    record(e) {
      const row = { t: Date.now(), ...e }
      if (row.error) row.error = String(row.error).slice(0, 300)
      recent.push(row)
      if (recent.length > KEEP) recent.splice(0, recent.length - KEEP)
      write(JSON.stringify(row) + '\n')
      return row
    },
    list: (plugin, n = 100) => recent.filter((r) => !plugin || r.plugin === plugin).slice(-n).reverse(),
  }
}
