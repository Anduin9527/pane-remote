#!/usr/bin/env node
// 发布前审计：扫描仓库里所有会被提交的文件（含构建产物）和提交记录，找个人信息、内网地址和密钥。
// 命中任何一条就以非 0 退出。
//
//   node scripts/audit.mjs                      只用内置的通用规则
//   node scripts/audit.mjs --deny <文件>         再加一份「绝不能出现」的词表（每行一个，# 开头是注释，不分大小写）
//                                               词表放在仓库外面，别把它提交进来
//   node scripts/audit.mjs --staged             只扫暂存区（给 pre-commit 用）
//   node scripts/audit.mjs --allow-email a@b,c@d  这些邮箱允许出现（比如提交作者自己的邮箱），不写进仓库
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const args = process.argv.slice(2)
const denyFile = args.includes('--deny') ? args[args.indexOf('--deny') + 1] : process.env.PANE_REMOTE_AUDIT_DENY
const staged = args.includes('--staged')
const allowEmails = new Set((args.includes('--allow-email') ? args[args.indexOf('--allow-email') + 1] : process.env.PANE_REMOTE_AUDIT_ALLOW_EMAIL || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 })
const files = staged
  ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)
  : git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)

// 示例里允许出现的占位值
const OK_EMAIL = /(@(example\.(com|org|net)|users\.noreply\.invalid|localhost)|^noreply@anthropic\.com)$/i // 最后一个是提交说明里 Claude 协作署名的固定地址
const OK_IP = new Set(['127.0.0.1', '0.0.0.0', '255.255.255.255'])
const OK_USER_DIR = /^\/(Users|home)\/(<[^>]+>|you|user|me|USERNAME|\$USER|\$\{USER\}|runner|shared)(?=$|[^A-Za-z0-9])/

const RULES = [
  ['邮箱地址', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => !OK_EMAIL.test(m) && !allowEmails.has(m.toLowerCase())],
  // ${变量} 是代码里拼出来的模板占位（比如打印给用户填的 systemd 文件），不是真实用户名
  ['个人目录路径', /\/(Users|home)\/[^\s/"'`)\]]+/g, (m) => !OK_USER_DIR.test(m) && !/^\/(Users|home)\/\$\{\w+\}$/.test(m)],
  ['IP 地址', /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g, (m) => !OK_IP.has(m) && m.split('.').every((x) => +x <= 255)],
  // 任何 *.ts.net 都算（新式 tailnet 名是两个英文词连起来的，不一定带 tail 前缀），示例用的占位名除外
  ['tailnet 主机名', /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\b/gi, (m) => !/^(xxx|example|your-?[a-z-]*|tailnet|machine|host|login)(\.|$)/i.test(m)],
  ['局域网机器名', /\b[a-z0-9][a-z0-9-]*\.local\b/gi, (m) => !/^(example|your-?[a-z-]*|machine|host)\./i.test(m)],
  ['Tailscale 节点地址', /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g],
  ['AWS 访问密钥', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['GitHub 令牌', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['OpenAI / Anthropic 密钥', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['Slack 令牌', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API 密钥', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Stripe 密钥', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['VAPID / 私钥字段', /"?private_?key"?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{30,}["']/gi],
  ['疑似写死的凭据', /\b(secret|token|password|passwd|api[_-]?key)\b\s*[:=]\s*["'][^"'\s$<{]{12,}["']/gi],
]

let deny = []
if (denyFile) {
  deny = fs.readFileSync(denyFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  if (!deny.length) { console.error(`词表 ${denyFile} 是空的`); process.exit(2) }
}

const findings = []
const report = (file, line, rule, text) => findings.push({ file, line, rule, text: text.length > 80 ? text.slice(0, 77) + '…' : text })

// 构建产物（压缩过的前端代码）里 SVG 路径之类的数字串很容易长得像 IP，只认写成地址的形式：引号、// 或 @ 后面
const BUNDLE_IP = /(?<=["'`/@])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?=["'`:/])/g
const allowed = []
const ALLOW_MARK = 'audit:' + 'allow' // 拆开写，免得这份脚本自己的代码行被当成豁免
const BUNDLE_SKIP = new Set(['局域网机器名']) // 压缩代码里 CSS 属性名之类的 .local 结尾的名字 太多，只在源码里查
function scanText(file, text) {
  const bundle = file.startsWith('public/assets/')
  // 压缩代码里的字符串可能写成 \uXXXX / \xXX，先还原再查
  if (bundle) text = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const lines = text.split('\n')
  lines.forEach((l, i) => {
    if (l.includes(ALLOW_MARK)) { allowed.push(`${file}:${i + 1}`); return } // 极少数确实需要的地方逐行豁免，结尾会全部列出来，要人看一眼
    for (const [name, rule, keep] of RULES) {
      if (bundle && BUNDLE_SKIP.has(name)) continue
      const re = bundle && name === 'IP 地址' ? BUNDLE_IP : rule
      for (const m of l.matchAll(re)) if (!keep || keep(m[0])) report(file, i + 1, name, m[0])
    }
    const low = l.toLowerCase()
    for (const w of deny) if (low.includes(w.toLowerCase())) report(file, i + 1, '个人词表', '（词表第 ' + (deny.indexOf(w) + 1) + ' 项）')
  })
}

for (const f of files) {
  const full = path.join(root, f)
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue
  // 文件名本身也查
  scanText(`${f}（文件名）`, f)
  const buf = staged ? Buffer.from(execFileSync('git', ['-C', root, 'show', `:${f}`], { maxBuffer: 64 << 20 })) : fs.readFileSync(full)
  const binary = buf.subarray(0, 8000).includes(0)
  // 二进制文件（图标等）只看里面的可读字符串，元数据里也可能藏着路径和名字
  const text = binary ? (buf.toString('latin1').match(/[\x20-\x7e]{6,}/g) || []).join('\n') : buf.toString('utf8')
  scanText(f, text)
}

// 提交记录：作者、提交者、提交说明，以及历史上每一次改动的内容（文件后来改掉了，旧版本还在历史里）、tag 的作者
if (!staged) {
  const tryGit = (...a) => { try { return git(...a) } catch { return '' } }
  const meta = tryGit('log', '--all', '--format=%an <%ae>%n%cn <%ce>%n%B')
  if (meta) scanText('（git 提交记录）', meta)
  const patches = tryGit('log', '--all', '-p', '--no-color', '--format=commit %h', '--', '.', ':!public/assets')
  if (patches) scanText('（git 历史改动）', patches.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('commit ')).join('\n'))
  const tags = tryGit('for-each-ref', '--format=%(taggername) %(taggeremail) %(contents)', 'refs/tags')
  if (tags.trim()) scanText('（git tag）', tags)
}

if (allowed.length) console.log(`有 ${allowed.length} 处用 ${ALLOW_MARK} 豁免，请人工确认：\n  ${allowed.join('\n  ')}`)
if (findings.length) {
  for (const x of findings) console.log(`✗ ${x.file}:${x.line}  [${x.rule}]  ${x.text}`)
  console.log(`\n审计不通过：${findings.length} 处${denyFile ? '' : '（没有给个人词表，只查了通用规则）'}`)
  process.exit(1)
}
console.log(`审计通过：${files.length} 个文件${staged ? '（暂存区）' : ' + 提交记录'}${denyFile ? `，含个人词表 ${deny.length} 项` : '，只查了通用规则（没给个人词表）'}`)
