#!/usr/bin/env node
// 首屏体积：构建后统计 index.html 直接引用的 js / css、modulepreload，以及入口脚本静态 import 到的分块（递归），
// 按 gzip（level 9，跟 server.mjs 发送时一样）算，超过上限退出码非 0。按需 import() 的分块不算。
//   node scripts/size.mjs [构建目录，默认 ../public] [上限 KB，默认 150]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(process.argv[2] || path.join(here, '../../public'))
const limit = Number(process.argv[3] || 150) * 1000
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')

const files = new Set()
const add = (ref) => { if (!/^(https?:)?\/\//.test(ref)) files.add(path.normalize(ref.replace(/^\.?\//, ''))) }
for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) add(m[1])
for (const m of html.matchAll(/<link[^>]*\brel="(?:stylesheet|modulepreload)"[^>]*\bhref="([^"]+)"/g)) add(m[1])
for (const m of html.matchAll(/<link[^>]*\bhref="([^"]+)"[^>]*\brel="(?:stylesheet|modulepreload)"/g)) add(m[1])

// 静态 import（import"./x.js" / from"./x.js"）跟进去；import("./x.js") 是按需的，不算
const queue = [...files].filter((f) => f.endsWith('.js'))
while (queue.length) {
  const f = queue.shift()
  const src = fs.readFileSync(path.join(dir, f), 'utf8')
  for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    const dep = path.normalize(path.join(path.dirname(f), m[1]))
    if (!files.has(dep)) { files.add(dep); queue.push(dep) }
  }
}

let total = 0
const rows = [...files].map((f) => {
  const buf = fs.readFileSync(path.join(dir, f))
  const gz = zlib.gzipSync(buf, { level: 9 }).length
  total += gz
  return { f, raw: buf.length, gz }
}).sort((a, b) => b.gz - a.gz)
const kb = (n) => (n / 1000).toFixed(1).padStart(7)
for (const r of rows) console.log(`${kb(r.gz)} KB gz  ${kb(r.raw)} KB  ${r.f}`)
console.log(`首屏合计 ${(total / 1000).toFixed(1)} KB gzip（${rows.length} 个文件，上限 ${limit / 1000} KB）`)
if (total > limit) { console.error(`超过上限 ${((total - limit) / 1000).toFixed(1)} KB`); process.exit(1) }
