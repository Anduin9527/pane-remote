// pane-remote 命令行的实现（入口是 bin/pane-remote，它负责挑 Node）
// 命令：安装、自检、开关模块、卸载。只用 Node 自带模块。
//
//   pane-remote init [--yes] [--port N] [--login 手机上的 Tailscale 登录名]   配置并启动（可以反复跑，已有的配置会保留）
//        [--skip-service]  不装后台服务（自己用别的方式跑 server/server.mjs）
//        [--skip-serve]    不动 tailscale serve（自己配反向代理）
//   pane-remote doctor                    逐项自检，给出修复办法
//   pane-remote status | start | stop | restart | logs
//   pane-remote enable <模块> | disable <模块>   模块：preview（预览浏览器）、openUrl（网址转手机）
//   pane-remote uninstall [--purge]       停服务、还原 hook、撤掉 tailscale serve；--purge 连配置和数据一起删
//   pane-remote relay ...                 增强版：中转模式，见 docs/relay.md
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '..')
const HOME = os.homedir()
const CONFIG_PATH = process.env.PANE_REMOTE_CONFIG || path.join(HOME, '.config/pane-remote/config.json')
const CONFIG_DIR = path.dirname(CONFIG_PATH)
const BRIDGE_ENV = path.join(CONFIG_DIR, 'bridge.env')
const LABEL = 'local.pane-remote.server'
const PLIST = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
const LOG = path.join(HOME, 'Library/Logs/pane-remote.log')
const HOOK = path.join(APP_DIR, 'agent/pane-event')
const NODE = process.execPath
const MODULES = {
  preview: '预览浏览器（手机上看电脑这边的网页和文件，需要 Chrome）',
  openUrl: '网址转手机（电脑上打开链接时，人在用手机就转到手机预览）',
  cursor: 'Cursor IDE 映射（会话、消息、待办、改动、内置浏览器；Cursor 要带调试端口启动）',
}
const CURSOR_APP = '/Applications/Cursor.app'

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined)
const c = { ok: (s) => `\x1b[32m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
const say = (...a) => console.log(...a)
const die = (msg) => { console.error(c.bad(`✗ ${msg}`)); process.exit(1) }
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 20000, ...o })
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return d; throw new Error(`${p} 不是合法的 JSON：${e.message}`) } }
function writeFileSafe(p, content, mode = 0o600) {
  // 是软链接（比如 dotfiles 管理的 settings.json）就写到它指向的文件，不把链接换成普通文件
  try { p = fs.realpathSync(p) } catch {}
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, p)
}
const tildify = (p) => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p)

// ---------- 找依赖 ----------
function which(name) {
  const r = run('/usr/bin/which', [name], { env: { PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` } })
  return r.status === 0 ? r.stdout.trim() : ''
}
const findWezterm = () => [which('wezterm'), '/opt/homebrew/bin/wezterm', '/usr/local/bin/wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'].find((p) => p && exists(p)) || ''
const findTailscale = () => [which('tailscale'), '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((p) => p && exists(p)) || ''
function findChrome() {
  const list = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
  return list.find(exists) || ''
}
function tailscaleInfo(ts) {
  if (!ts) return null
  const r = run(ts, ['status', '--json'])
  if (r.status !== 0) return { running: false }
  try {
    const d = JSON.parse(r.stdout)
    const self = d.Self || {}
    const user = d.User?.[self.UserID] || {}
    // 打了标签的设备（tagged）不属于任何人，LoginName 是 tagged-devices，不能当成手机那头的账号
    const tagged = !!self.Tags?.length || user.LoginName === 'tagged-devices'
    return { running: d.BackendState === 'Running', state: d.BackendState, host: (self.DNSName || '').replace(/\.$/, ''), login: tagged ? '' : user.LoginName || '', tagged, tailnet: d.CurrentTailnet?.Name || '' }
  } catch { return { running: false } }
}
function serveStatus(ts) {
  const r = run(ts, ['serve', 'status', '--json'])
  try { return JSON.parse(r.stdout || '{}') } catch { return {} }
}
/** 现在 tailscale serve 在哪个 https 端口把 / 转给了我们的端口；没有就 0 */
function servedPort(ts, port) {
  const web = serveStatus(ts).Web || {}
  for (const [hostPort, v] of Object.entries(web)) {
    const proxy = v?.Handlers?.['/']?.Proxy || ''
    if (proxy.replace(/\/$/, '') === `http://127.0.0.1:${port}`) return Number(hostPort.split(':').pop())
  }
  return 0
}
function httpsPortTaken(ts, httpsPort) {
  return Object.keys(serveStatus(ts).Web || {}).some((hp) => hp.endsWith(`:${httpsPort}`))
}

// Claude Code 的配置目录：~/.claude，以及用 CLAUDE_CONFIG_DIR 分开的 ~/.claude-xxx
function claudeProfiles() {
  return fs.readdirSync(HOME).filter((n) => /^\.claude(-[\w.-]+)?$/.test(n)).map((n) => path.join(HOME, n))
    .filter((d) => { try { return fs.statSync(d).isDirectory() && (exists(path.join(d, 'settings.json')) || exists(path.join(d, 'projects'))) } catch { return false } })
}
const wrapperFor = (dir) => (path.basename(dir) === '.claude' ? 'claude' : `CLAUDE_CONFIG_DIR="$HOME/${path.basename(dir)}" claude`)

// ---------- hook ----------
const CLAUDE_HOOKS = { Notification: 'notify', SessionStart: 'session', Stop: 'stop', StopFailure: 'failure', UserPromptSubmit: 'prompt' }
const CODEX_HOOKS = { PermissionRequest: 'permission', SessionStart: 'session', Stop: 'stop', UserPromptSubmit: 'prompt' }
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('/agent/pane-event') && cmd.includes('pane-event')
// hook 命令会交给 shell 执行：路径用单引号包起来（里面的单引号按 '\'' 转义），$、反引号、双引号都不会被解释
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const hookCmd = (kind, agent) => `${shq(HOOK)} ${kind}${agent ? ` --agent ${agent}` : ''}`

function stripHooks(hooks) {
  let removed = 0
  for (const [ev, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) continue
    hooks[ev] = groups.map((g) => {
      const before = g.hooks?.length || 0
      const kept = (g.hooks || []).filter((h) => !isOurs(h.command))
      removed += before - kept.length
      return { ...g, hooks: kept }
    }).filter((g) => g.hooks.length)
    if (!hooks[ev].length) delete hooks[ev]
  }
  return removed
}
function backup(p) {
  if (!exists(p)) return ''
  const b = `${p}.pane-remote-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  fs.copyFileSync(p, b)
  return b
}
/** 往一个 hook 配置文件里装上（或去掉）我们的 hook；不动别的 hook */
function patchHooks(file, map, agent, install) {
  const d = readJson(file, {})
  d.hooks = d.hooks || {}
  const removed = stripHooks(d.hooks)
  if (install) for (const [ev, kind] of Object.entries(map)) (d.hooks[ev] = d.hooks[ev] || []).push({ hooks: [{ type: 'command', command: hookCmd(kind, agent) }] })
  if (!install && !removed) return { changed: false }
  if (!Object.keys(d.hooks).length) delete d.hooks
  const next = JSON.stringify(d, null, 2) + '\n'
  if (exists(file) && fs.readFileSync(file, 'utf8') === next) return { changed: false } // 已经装好了，不重写、不再备份
  const b = backup(file)
  writeFileSafe(file, next, exists(file) ? fs.statSync(file).mode & 0o777 : 0o600)
  return { changed: true, backup: b }
}
const hooksInstalled = (file, map) => {
  const d = readJson(file, {})
  return Object.keys(map).every((ev) => (d.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => isOurs(h.command) && h.command.includes(HOOK))))
}

// ---------- launchd ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(NODE)}</string><string>${esc(path.join(APP_DIR, 'server/server.mjs'))}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PANE_REMOTE_CONFIG</key><string>${esc(CONFIG_PATH)}</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(LOG)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG)}</string>
</dict>
</plist>
`
}
const uid = () => process.getuid()
const loaded = () => run('/bin/launchctl', ['print', `gui/${uid()}/${LABEL}`]).status === 0
function startService() {
  writeFileSafe(PLIST, plist(), 0o644)
  if (loaded()) run('/bin/launchctl', ['bootout', `gui/${uid()}/${LABEL}`])
  const r = run('/bin/launchctl', ['bootstrap', `gui/${uid()}`, PLIST])
  if (r.status !== 0 && !loaded()) throw new Error(`启动服务失败：${(r.stderr || r.stdout).trim()}`)
}
function stopService() { if (loaded()) run('/bin/launchctl', ['bootout', `gui/${uid()}/${LABEL}`]) }
const restartService = () => { if (loaded()) run('/bin/launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`]); else startService() }

// 用和 tailscale serve 一样的请求头直接问本机服务，确认它活着、鉴权配置对
// fetch 会忽略自定义的 Host 头，这里用 http.request 才能带上
function probe(cfg) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/api/config', timeout: 3000,
      headers: { 'tailscale-user-login': cfg.allowedLogins?.[0] || '', host: cfg.serveHosts?.[0] || 'localhost' } }, (res) => { res.resume(); resolve(res.statusCode) })
    req.on('error', () => resolve(0))
    req.on('timeout', () => { req.destroy(); resolve(0) })
    req.end()
  })
}

const MUX_DEFAULT = path.join(HOME, '.local/share/wezterm/sock')
const isSocket = (p) => { try { return fs.statSync(p).isSocket() } catch { return false } }

// ---------- 配置 ----------
function writeBridgeEnv(cfg) {
  const lines = [`WEZTERM=${cfg.paths.wezterm}`, `NODE=${NODE}`]
  if (cfg.paths.chrome) lines.push(`CHROME=${cfg.paths.chrome}`)
  if (cfg.paths.muxSocket) lines.push(`MUX_SOCK=${cfg.paths.muxSocket}`)
  for (const l of lines) if (/[\n\r]/.test(l)) throw new Error('路径里不能有换行')
  writeFileSafe(BRIDGE_ENV, lines.join('\n') + '\n')
}

async function ask(q, def = true) {
  if (flag('--yes') || !process.stdin.isTTY) return def
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
  rl.close()
  return a ? a.startsWith('y') : def
}

// ---------- init ----------
async function init() {
  if (process.platform !== 'darwin') die('目前只支持 macOS')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) die(`Node 版本太旧（${process.versions.node}），需要 20 以上；用 install.sh 会自动装好`)
  if (!exists(path.join(APP_DIR, 'node_modules/ws'))) die('依赖没装：先在仓库目录跑 ./install.sh（或 npm ci --omit=dev）')
  if (!exists(path.join(APP_DIR, 'public/index.html'))) die('前端没构建：仓库里缺 public/，重新拉一下代码')

  say(c.b('\n1/5 检查依赖'))
  const wezterm = findWezterm()
  const ts = findTailscale()
  const chrome = findChrome()
  const missing = []
  say(wezterm ? `  ${c.ok('✓')} WezTerm  ${c.dim(wezterm)}` : `  ${c.bad('✗')} WezTerm 没装`), wezterm || missing.push('wezterm')
  say(ts ? `  ${c.ok('✓')} Tailscale ${c.dim(ts)}` : `  ${c.bad('✗')} Tailscale 没装`), ts || missing.push('tailscale-app')
  say(chrome ? `  ${c.ok('✓')} Chrome   ${c.dim(chrome)}` : `  ${c.warn('!')} 没找到 Chrome：预览浏览器模块会先关掉（装了 Chrome 后 pane-remote enable preview）`)
  say(exists('/usr/bin/python3') ? `  ${c.ok('✓')} python3` : `  ${c.bad('✗')} 没有 /usr/bin/python3（装 Xcode 命令行工具：xcode-select --install）`)
  if (missing.length) die(`缺 ${missing.join('、')}：跑 ./install.sh 会用 Homebrew 装好，或者手动 brew install --cask ${missing.join(' ')}`)
  if (!exists('/usr/bin/python3')) die('缺 python3')

  const tsi = tailscaleInfo(ts)
  if (!tsi?.running) die(`Tailscale 没登录或没在运行（${tsi?.state || '未知'}）：打开 Tailscale 登录后再跑一次`)
  if (!tsi.host) die('拿不到这台电脑在 tailnet 里的主机名：在 Tailscale 管理后台打开 MagicDNS 和 HTTPS 证书')
  // 允许访问的账号 = 手机上登录的 Tailscale 账号。默认就是这台电脑登录的账号（同一个人的手机和电脑）
  let login = opt('--login') || tsi.login
  if (!login) {
    if (flag('--yes') || !process.stdin.isTTY) die('这台电脑是标签设备（tagged），看不出是谁的：用 --login <你手机上 Tailscale 的登录名> 指定')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    login = (await rl.question('  这台电脑是标签设备，请输入你手机上 Tailscale 的登录名：')).trim()
    rl.close()
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(login) && !/^[\w.-]+@?[\w.-]*$/.test(login)) die(`登录名看着不对：${login}`)
  say(`  ${c.ok('✓')} Tailscale 已登录  ${c.dim(tsi.host)}；允许 ${c.b(login)} 访问`)

  say(c.b('\n2/5 写配置'))
  const prev = readJson(CONFIG_PATH, {})
  const profiles = claudeProfiles()
  const cfg = {
    ...prev,
    mode: 'local',
    port: Number(opt('--port')) || prev.port || 8787,
    allowedLogins: [...new Set([...(prev.allowedLogins || []).filter((l) => l !== 'tagged-devices'), login])],
    serveHosts: [...new Set([...(prev.serveHosts || []), tsi.host])],
    modules: { preview: !!chrome, openUrl: false, ...(prev.modules || {}) },
    presets: prev.presets || [
      ...(which('claude') || profiles.length ? [{ label: 'Claude Code', command: 'claude' }] : []),
      ...(which('codex') ? [{ label: 'Codex', command: 'codex' }] : []),
    ],
    claudeWrappers: { ...Object.fromEntries(profiles.map((d) => [path.basename(d), wrapperFor(d)])), ...(prev.claudeWrappers || {}) },
    // 配了 WezTerm 持久化（unix domain）就直接连 mux server，窗口关了也能用（docs/advanced.md）
    paths: { ...(prev.paths || {}), wezterm, chrome: chrome || prev.paths?.chrome || '', muxSocket: prev.paths?.muxSocket || (isSocket(MUX_DEFAULT) ? MUX_DEFAULT : '') },
  }
  if (!chrome) cfg.modules.preview = false
  writeFileSafe(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
  writeBridgeEnv(cfg)
  say(`  ${c.ok('✓')} ${tildify(CONFIG_PATH)}`)
  say(`    只允许 ${cfg.allowedLogins.join('、')} 访问；要加别的账号就编辑 allowedLogins`)

  say(c.b('\n3/5 装 hook（让手机知道 Claude / Codex 什么时候做完、什么时候在等你）'))
  if (!profiles.length) say(`  ${c.warn('!')} 没找到 Claude Code 的配置目录（~/.claude*）；装好 Claude Code 后再跑一次 init`)
  for (const d of profiles) {
    const f = path.join(d, 'settings.json')
    const r = patchHooks(f, CLAUDE_HOOKS, '', true)
    say(`  ${c.ok('✓')} ${tildify(f)}${r.backup ? c.dim(`（原文件备份：${path.basename(r.backup)}）`) : ''}`)
  }
  const codexHooks = path.join(HOME, '.codex/hooks.json')
  if (exists(path.join(HOME, '.codex'))) {
    if (await ask('  发现 Codex：也给它装 hook 吗？（装完要在 Codex 里确认信任这些 hook 才生效）')) {
      const r = patchHooks(codexHooks, CODEX_HOOKS, 'codex', true)
      say(`  ${c.ok('✓')} ${tildify(codexHooks)}${r.backup ? c.dim(`（备份：${path.basename(r.backup)}）`) : ''}`)
    }
  }
  say(c.dim('  已经开着的 Claude 会话要重开一次才会用上新 hook'))

  say(c.b('\n4/5 启动服务'))
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  if (flag('--skip-service')) say(c.dim(`  跳过（--skip-service）：自己运行 PANE_REMOTE_CONFIG=${tildify(CONFIG_PATH)} node server/server.mjs`))
  else startService()
  let status = 0
  for (let i = 0; i < 20 && status !== 200; i++) { await new Promise((r) => setTimeout(r, 300)); status = await probe(cfg) }
  if (status !== 200 && flag('--skip-service')) say(`  ${c.warn('!')} 服务现在没响应（${status || '连不上'}），启动后跑 pane-remote doctor 确认`)
  else if (status !== 200) die(`服务没起来（${status || '连不上'}），看日志：tail -50 ${tildify(LOG)}`)
  if (status === 200) say(`  ${c.ok('✓')} 服务在 127.0.0.1:${cfg.port}${flag('--skip-service') ? '' : `（开机自动启动，日志 ${tildify(LOG)}）`}`)

  say(c.b('\n5/5 用 tailscale serve 发布到你的 tailnet'))
  let httpsPort = servedPort(ts, cfg.port)
  if (flag('--skip-serve')) {
    httpsPort = httpsPort || 443
    say(c.dim(`  跳过（--skip-serve）：自己执行 tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}`))
  } else if (!httpsPort) {
    httpsPort = httpsPortTaken(ts, 443) ? 8443 : 443
    if (httpsPortTaken(ts, httpsPort)) die(`tailscale serve 的 443 和 8443 都被别的服务占了；手动选个端口：tailscale serve --bg --https=<端口> http://127.0.0.1:${cfg.port}`)
    if (httpsPort !== 443) say(`  ${c.warn('!')} 443 已经被别的服务用了，改用 ${httpsPort}`)
    const r = run(ts, ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${cfg.port}`])
    if (r.status !== 0) die(`tailscale serve 失败：${(r.stderr || r.stdout).trim()}\n  常见原因：tailnet 没开 HTTPS 证书（管理后台 DNS 页面打开 HTTPS Certificates）`)
  }
  const url = `https://${tsi.host}${httpsPort === 443 ? '' : `:${httpsPort}`}/`
  say(`  ${c.ok('✓')} ${url}`)

  say(c.b(`\n装好了。手机上：`))
  say(`  1. 装 Tailscale（App Store 搜 Tailscale），登录 ${c.b(login)}`)
  say(`  2. Safari 打开 ${c.b(url)}`)
  say(`  3. 分享 → 添加到主屏幕（推送通知只在主屏幕打开的网页里能用）`)
  const qr = which('qrencode')
  if (qr) spawnSync(qr, ['-t', 'ANSIUTF8', url], { stdio: 'inherit' })
  say(c.dim(`\n有问题跑 pane-remote doctor。可选模块：pane-remote enable openUrl（网址转手机）`))
}

// ---------- doctor ----------
async function doctor() {
  let bad = 0
  const ok = (m) => say(`  ${c.ok('✓')} ${m}`)
  const fail = (m, fix) => { bad++; say(`  ${c.bad('✗')} ${m}${fix ? `\n      ${c.dim('→ ' + fix)}` : ''}`) }
  const warn = (m, fix) => say(`  ${c.warn('!')} ${m}${fix ? `\n      ${c.dim('→ ' + fix)}` : ''}`)
  say(c.b('pane-remote 自检'))
  const cfg = readJson(CONFIG_PATH, null)
  if (!cfg) { fail(`没有配置文件 ${tildify(CONFIG_PATH)}`, '跑 pane-remote init'); return process.exit(1) }
  ok(`配置 ${tildify(CONFIG_PATH)}（${cfg.mode} 模式）`)
  Number(process.versions.node.split('.')[0]) >= 20 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} 太旧`, '需要 20 以上')
  exists(path.join(APP_DIR, 'node_modules/ws')) ? ok('依赖已装') : fail('依赖没装', `cd ${tildify(APP_DIR)} && npm ci --omit=dev`)
  cfg.allowedLogins?.length ? ok(`允许访问：${cfg.allowedLogins.join('、')}`) : fail('allowedLogins 是空的，谁都进不来', '跑 pane-remote init')

  const wez = cfg.paths?.wezterm
  if (!wez || !exists(wez)) fail('找不到 wezterm', 'brew install --cask wezterm，然后 pane-remote init')
  else {
    const env = { ...process.env, SSH_ORIGINAL_COMMAND: 'list', PANE_REMOTE_BRIDGE_ENV: BRIDGE_ENV }
    const r = run(path.join(APP_DIR, 'agent/bridge'), [], { env })
    if (r.status === 0) { try { ok(`WezTerm 能连上，${JSON.parse(r.stdout).length} 个 pane`) } catch { fail('WezTerm 返回的不是 pane 列表', r.stdout.slice(0, 200)) } }
    else fail(`WezTerm 连不上：${(r.stderr || '').trim().split('\n').pop()}`, '先打开 WezTerm 窗口（或配置持久化 mux，见 docs/advanced.md）')
  }
  exists('/usr/bin/python3') ? ok('python3') : fail('没有 /usr/bin/python3', 'xcode-select --install')

  if (cfg.mode === 'local') {
    const ts = findTailscale()
    const tsi = tailscaleInfo(ts)
    if (!tsi?.running) fail('Tailscale 没在运行或没登录', '打开 Tailscale 登录')
    else {
      ok(`Tailscale：${tsi.tagged ? '标签设备' : tsi.login}  ${c.dim(tsi.host)}`)
      if (!cfg.serveHosts?.includes(tsi.host)) fail(`这台电脑的 tailnet 主机名 ${tsi.host} 不在 serveHosts 里（换过名字？）`, '跑 pane-remote init')
      const p = servedPort(ts, cfg.port)
      p ? ok(`tailscale serve：https://${tsi.host}${p === 443 ? '' : ':' + p}/`) : fail('tailscale serve 没指向本服务', '跑 pane-remote init')
    }
    loaded() ? ok('后台服务已加载（launchd）') : fail('后台服务没加载', 'pane-remote start')
    const st = await probe(cfg)
    st === 200 ? ok(`服务正常响应（127.0.0.1:${cfg.port}）`) : fail(`服务没响应（${st || '连不上'}）`, `看日志：tail -50 ${tildify(LOG)}`)
  }

  const profiles = claudeProfiles()
  for (const d of profiles) {
    const f = path.join(d, 'settings.json')
    hooksInstalled(f, CLAUDE_HOOKS) ? ok(`hook 已装：${tildify(f)}`) : fail(`hook 没装全：${tildify(f)}`, '跑 pane-remote init')
  }
  const ev = path.join(HOME, '.local/state/pane-remote/events.jsonl')
  if (exists(ev)) ok(`hook 有在记录事件（最近 ${Math.round((Date.now() - fs.statSync(ev).mtimeMs) / 60000)} 分钟前）`)
  else warn('还没收到过 hook 事件', '在 WezTerm 里开一个新的 Claude 会话、发一句话试试')

  if (cfg.modules?.preview) {
    cfg.paths?.chrome && exists(cfg.paths.chrome) ? ok(`预览浏览器：${tildify(cfg.paths.chrome)}`) : fail('预览模块开着但找不到 Chrome', '装 Chrome 后跑 pane-remote init，或 pane-remote disable preview')
  }
  if (cfg.modules?.cursor) {
    if (!exists(CURSOR_APP)) fail('Cursor 模块开着但没装 Cursor', 'pane-remote disable cursor')
    else {
      let up = false
      try { up = (await fetch('http://127.0.0.1:9333/json/version', { signal: AbortSignal.timeout(1500) })).ok } catch {}
      up ? ok('Cursor 已带调试端口运行，可以接入') : warn('Cursor 没有带调试端口运行', '在手机的 Cursor 页面点「启动 Cursor」或「重启并接入」')
    }
  }
  if (cfg.modules?.openUrl) {
    const link = openLinkPath()
    link && exists(link) ? ok(`网址转手机：${tildify(link)}`) : fail('网址转手机开着但没装好', 'pane-remote enable openUrl')
  }
  say(bad ? c.bad(`\n${bad} 项有问题`) : c.ok('\n全部正常'))
  process.exit(bad ? 1 : 0)
}

// ---------- 模块 ----------
const OPEN_TARGET = path.join(APP_DIR, 'agent/open')
/** 这个路径是不是指向我们自己的 agent/open 的软链接（完整比较解析后的路径） */
function isOurOpenLink(link) {
  try { return fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(OPEN_TARGET) } catch { return false }
}
// 网址转手机：把 agent/open 链接成 PATH 里排在 /usr/bin 前面的 open
function openLinkPath() {
  const dirs = (process.env.PATH || '').split(':')
  const usr = dirs.indexOf('/usr/bin')
  const cand = [path.join(HOME, '.local/bin'), path.join(HOME, 'bin')].find((d) => dirs.indexOf(d) >= 0 && (usr < 0 || dirs.indexOf(d) < usr))
  return cand ? path.join(cand, 'open') : ''
}
async function setModule(name, on) {
  if (!MODULES[name]) die(`没有这个模块：${name}。可选：${Object.keys(MODULES).join('、')}`)
  const cfg = readJson(CONFIG_PATH, null) || die('先跑 pane-remote init')
  if (name === 'preview' && on) {
    const chrome = findChrome()
    if (!chrome) die('没找到 Chrome：装 Google Chrome（brew install --cask google-chrome）')
    cfg.paths = { ...cfg.paths, chrome }
    writeBridgeEnv(cfg)
  }
  if (name === 'cursor' && on) {
    if (!exists(CURSOR_APP)) die('没找到 Cursor（/Applications/Cursor.app）')
    say(c.dim('  Cursor 要带调试端口（只监听本机 127.0.0.1:9333）启动才能接入：'))
    say(c.dim('  · Cursor 没开时，手机上点「启动 Cursor」或新建会话会自动带端口启动'))
    say(c.dim('  · Cursor 已经用普通方式开着时，手机上会提示「重启并接入」，你确认后它会正常退出再重开（有没保存的内容 Cursor 会先问你）'))
    say(c.dim('  · 调试端口能完全控制 Cursor：只在只有你自己用的电脑上开'))
    let sqlite = false
    try { await import('node:sqlite'); sqlite = true } catch {}
    if (!sqlite) say(`  ${c.warn('!')} 当前 Node（${process.version}）没有 node:sqlite，看不到完整历史消息，只有实时画面里的内容；换 Node 22.13 以上再跑 pane-remote init`)
  }
  if (name === 'openUrl') {
    const link = openLinkPath()
    if (on) {
      if (!link) die('PATH 里没有排在 /usr/bin 前面的 ~/.local/bin 或 ~/bin：先在 ~/.zshrc 里加 export PATH="$HOME/.local/bin:$PATH"，开个新终端再试')
      let taken = false
      try { fs.lstatSync(link); taken = true } catch {}
      if (taken && !isOurOpenLink(link)) die(`${tildify(link)} 已经被别的东西占用了，不覆盖（自己处理掉再试）`)
      fs.mkdirSync(path.dirname(link), { recursive: true })
      try { fs.unlinkSync(link) } catch {}
      fs.symlinkSync(OPEN_TARGET, link)
      say(`  ${c.ok('✓')} ${tildify(link)} → agent/open`)
      say(c.dim('  想让 Claude 等程序打开网页时也转过来，在 ~/.zshrc 里加：export BROWSER="' + path.join(APP_DIR, 'agent/pane-open') + '"'))
    } else if (link && isOurOpenLink(link)) {
      fs.unlinkSync(link)
      say(`  ${c.ok('✓')} 去掉了 ${tildify(link)}`)
    }
  }
  cfg.modules = { ...cfg.modules, [name]: on }
  writeFileSafe(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n')
  if (loaded()) restartService()
  say(`${c.ok('✓')} ${MODULES[name]}：${on ? '已开启' : '已关闭'}`)
}

// ---------- uninstall ----------
async function uninstall() {
  const cfg = readJson(CONFIG_PATH, {})
  stopService()
  try { fs.unlinkSync(PLIST) } catch {}
  say(`${c.ok('✓')} 停掉并移除后台服务`)
  const ts = findTailscale()
  if (ts && cfg.port) {
    const p = servedPort(ts, cfg.port)
    if (p) { run(ts, ['serve', `--https=${p}`, 'off']); say(`${c.ok('✓')} 撤掉 tailscale serve（https 端口 ${p}）`) }
  }
  for (const d of claudeProfiles()) {
    const f = path.join(d, 'settings.json')
    if (exists(f) && patchHooks(f, CLAUDE_HOOKS, '', false).changed) say(`${c.ok('✓')} 去掉 hook：${tildify(f)}`)
  }
  const codex = path.join(HOME, '.codex/hooks.json')
  if (exists(codex) && patchHooks(codex, CODEX_HOOKS, 'codex', false).changed) say(`${c.ok('✓')} 去掉 hook：${tildify(codex)}`)
  const link = openLinkPath()
  if (link && isOurOpenLink(link)) { fs.unlinkSync(link); say(`${c.ok('✓')} 去掉 ${tildify(link)}`) }
  const stopPreview = run(path.join(APP_DIR, 'agent/bridge'), [], { env: { ...process.env, SSH_ORIGINAL_COMMAND: 'preview-stop', PANE_REMOTE_BRIDGE_ENV: BRIDGE_ENV } })
  if (stopPreview.stdout?.startsWith('stopped')) say(`${c.ok('✓')} 关掉预览用的 Chrome`)
  if (flag('--purge')) {
    // 只删名字是 pane-remote、在家目录里面的目录：配置被改坏（比如 dataDir 写成 ~）也不会误删别的东西
    const expand = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME)
    for (const p of [CONFIG_DIR, expand(cfg.dataDir) || path.join(HOME, '.local/share/pane-remote'), path.join(HOME, '.local/state/pane-remote')]) {
      const abs = path.resolve(p)
      if (path.basename(abs) !== 'pane-remote' || !abs.startsWith(HOME + '/') || abs.split('/').length < HOME.split('/').length + 2) { say(c.warn(`  跳过 ${abs}（不像是 pane-remote 自己的目录）`)); continue }
      fs.rmSync(abs, { recursive: true, force: true })
    }
    say(`${c.ok('✓')} 删掉配置和数据（推送订阅、预览浏览器的登录状态都没了）`)
  } else say(c.dim(`配置和数据留着（${tildify(CONFIG_DIR)}），要一起删就加 --purge`))
  say(c.dim('hook 改动前的备份是 settings.json.pane-remote-backup-*，确认没问题可以删掉'))
}

// ---------- 入口 ----------
const cmd = args[0]
try {
  switch (cmd) {
    case 'init': await init(); break
    case 'doctor': await doctor(); break
    case 'start': startService(); say(c.ok('✓ 已启动')); break
    case 'stop': stopService(); say(c.ok('✓ 已停止')); break
    case 'restart': restartService(); say(c.ok('✓ 已重启')); break
    case 'status': { const cfg = readJson(CONFIG_PATH, null); say(loaded() ? c.ok('运行中') : c.warn('没在运行')); if (cfg) say(`端口 ${cfg.port}，响应 ${(await probe(cfg)) || '无'}`); break }
    case 'logs': spawnSync('/usr/bin/tail', ['-n', '100', '-f', LOG], { stdio: 'inherit' }); break
    case 'enable': await setModule(args[1], true); break
    case 'disable': await setModule(args[1], false); break
    case 'uninstall': await uninstall(); break
    case 'relay': {
      const sub = path.join(APP_DIR, 'relay/relay.mjs')
      const r = spawnSync(NODE, [sub, ...args.slice(1)], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
    default:
      say(`用法：pane-remote <命令>
  init        配置并启动（可以反复跑）
  doctor      自检
  status | start | stop | restart | logs
  enable <模块> | disable <模块>   ${Object.entries(MODULES).map(([k, v]) => `${k}：${v}`).join('；')}
  uninstall [--purge]
  relay       增强版中转模式（docs/relay.md）`)
      process.exit(cmd ? 1 : 0)
  }
} catch (e) { die(e.message) }
