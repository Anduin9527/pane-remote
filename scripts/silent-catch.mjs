#!/usr/bin/env node
// 列出「把错误吞掉」的地方：出错了没人知道，问题报告也抓不到。
//   node scripts/silent-catch.mjs [目录...]      默认扫仓库里的源码（不含 node_modules、构建产物）
// ignore: 下面这行是说明文字。认为是吞掉：JS/TS/Svelte 的 catch {} / catch (e) {} / .catch(() => {}) / .catch(() => null)，
//             Python 的 except…: pass，bash 的 2>/dev/null || true 不算（那是命令行习惯）。
// 确实可以忽略的，在同一行或上一行写 `ignore:` 加理由（// ignore: 订阅过期是正常情况），就不再列出。
// 退出码：有没标注的吞错就是 1（可以接进检查流程）
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['.']
const SKIP = /(^|\/)(node_modules|public|dist|\.git|legacy|vendor)(\/|$)/
const JS = /\.(m?js|ts|svelte)$/
const PY_SHEBANG = /^#!.*python/
const RULES_JS = [
  /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/,
  /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|null|undefined|void 0)\s*\)/,
]
const RULE_PY = /^\s*except\b[^:]*:\s*(pass)?\s*$/

const hits = []
function scan(file) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const isJs = JS.test(file)
  const isPy = file.endsWith('.py') || (!path.extname(file) && PY_SHEBANG.test(lines[0] || ''))
  if (!isJs && !isPy) return
  lines.forEach((l, i) => {
    const prev = lines[i - 1] || ''
    if (/ignore:/.test(l) || /ignore:/.test(prev)) return
    if (isJs && RULES_JS.some((r) => r.test(l))) hits.push([file, i + 1, l.trim()])
    if (isPy && RULE_PY.test(l)) {
      const next = (lines[i + 1] || '').trim()
      if (/:\s*pass\s*$/.test(l) || next === 'pass') hits.push([file, i + 1, `${l.trim()} ${next === 'pass' ? 'pass' : ''}`.trim()])
    }
  })
}
function walk(p) {
  const rel = path.relative(root, p)
  if (rel && SKIP.test(rel)) return
  const st = fs.statSync(p)
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f))
  else if (st.size < 2 << 20) scan(p)
}
for (const d of dirs) walk(path.resolve(root, d))
const byFile = {}
for (const [f, n, l] of hits) (byFile[path.relative(root, f)] ||= []).push(`${n}: ${l.slice(0, 140)}`)
for (const [f, ls] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${f} (${ls.length})`)
  for (const l of ls) console.log(`  ${l}`)
}
console.log(`\n${hits.length} 处吞掉错误、没标 ignore:（${Object.keys(byFile).length} 个文件）`)
process.exit(hits.length ? 1 : 0)
