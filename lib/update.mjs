// pane-remote update：从安装时的 git origin（只认 https）安全地增量更新
//
//   pane-remote update            拉取、预览、确认后快进合并，只重做改动涉及的步骤，失败自动回滚
//   pane-remote update --check    只拉取和预览；退出码 0 = 已是最新，10 = 有更新
//   pane-remote update --yes      不问确认（不是终端时必须加）
//   pane-remote update --rollback 回到上一次更新之前的版本
//
// 规则：
//   - 只从 origin 拉，origin 必须是 https 地址，并且和配置里记下的 updateSource 一致（第一次会记下来）
//   - 工作区有改动、或者本地历史和上游分叉了，一律拒绝；只做 git merge --ff-only，不 reset / stash 用户的改动
//   - 用户确认之前不执行拉下来的任何代码；之后的步骤（装依赖、重装 hook、重启服务…）只按改动的文件挑着做
//   - 应用后跑 doctor：比更新前多出失败项、或者某一步失败，就 git reset --hard 回旧版本（这时工作区是刚快进过的干净状态），
//     再用旧版本把同样的步骤重做一遍
//
// 测试用（只在测试时设置）：PANE_REMOTE_UPDATE_TEST=1 时装依赖、mousectl、重启服务都只打印不执行，
// hook / bridge.env 只预演（--dry-run）；PANE_REMOTE_UPDATE_TEST_FAIL=<步骤名> 模拟这一步失败。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { spawnSync } from 'node:child_process'

const TEST = process.env.PANE_REMOTE_UPDATE_TEST === '1'
const TEST_FAIL = TEST ? process.env.PANE_REMOTE_UPDATE_TEST_FAIL || '' : ''
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s@]+$/
// 测试时用本机的裸仓库当上游（file:///…），正常使用只认 https
const SOURCE_OK = (u) => HTTPS_URL.test(u) || (TEST && /^file:\/\/\/\S+$/.test(u))
const SIGN_ID = 'pane-remote local signing'

// 远端来的文字（提交说明、文件名）可能带终端转义序列或双向控制符：显示前换成 ?
export const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '?')

function git(appDir, a, o = {}) {
  const r = spawnSync('git', ['-C', appDir, ...a], { encoding: 'utf8', timeout: o.timeout || 30000, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, ...o })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim(), raw: r.stdout || '' }
}

/** 仓库现在的更新来源 { url, branch }；不是 git 仓库、没有上游、origin 不是 https 就是 null */
export function gitSource(appDir) {
  const up = git(appDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!up.ok || !up.out.startsWith('origin/')) return null
  // ls-remote --get-url 会把 url.*.insteadOf 的改写算进去，得到的是 git 真正会连的地址
  const url = git(appDir, ['ls-remote', '--get-url', 'origin'])
  if (!url.ok || !SOURCE_OK(url.out)) return null
  return { url: url.out, branch: up.out.slice('origin/'.length) }
}

/** 文件属于哪一块（预览分组用） */
function area(f) {
  if (f === 'package.json' || f === 'package-lock.json') return 'deps'
  if (f.startsWith('agent/screen/')) return 'screen'
  if (f.startsWith('agent/mac/')) return 'mac'
  if (f.startsWith('server/') || f.startsWith('platform/') || f.startsWith('plugins/')) return 'server'
  if (f.startsWith('host/')) return 'host'
  if (f.startsWith('public/')) return 'public'
  if (f.startsWith('web/')) return 'web'
  if (f.startsWith('agent/')) return 'agent'
  if (f.startsWith('lib/') || f.startsWith('bin/')) return 'cli'
  if (f.startsWith('relay/')) return 'relay'
  if (f === 'install.sh' || f === 'Brewfile') return 'install'
  if (f.startsWith('docs/') || /^README/.test(f) || f === 'LICENSE') return 'docs'
  return 'other'
}

/** 按改动的文件挑步骤（顺序就是执行顺序） */
export function planSteps(files, cfg, env = {}) {
  const has = (p) => files.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p))
  const steps = []
  const deps = has('package.json') || has('package-lock.json')
  if (deps) steps.push('deps')
  if (cfg.modules?.screen && (has('agent/screen/mousectl.swift') || has('agent/screen/install-mousectl.sh'))) steps.push('mousectl')
  // hook 的事件表写在 lib/cli.mjs 里；hook 命令指向 agent/pane-event
  if (has('lib/cli.mjs') || has('agent/pane-event')) steps.push('hooks')
  // bridge.env 由 lib/cli.mjs 写、agent/bridge 读
  if (env.bridgeEnv && (has('lib/cli.mjs') || has('agent/bridge'))) steps.push('bridgeEnv')
  const serverSide = deps || has('server/') || has('public/') || has('platform/') || has('plugins/') || has('host/') || files.some((f) => f.startsWith('agent/') && !/^agent\/screen\/(mousectl\.swift|install-mousectl\.sh)$/.test(f))
  if (serverSide) steps.push('restart')
  // pane-host 从仓库直接跑 host/ 和 agent/pane-transcript：这些变了（或依赖变了）要换成新版
  if (deps || has('host/') || has('agent/pane-transcript')) steps.push('host')
  return steps
}

/** 这台 Mac 是不是中转模式（装了反向隧道），以及中转服务器那边要不要跟着更新 */
function notices(files, env) {
  const out = []
  const has = (p) => files.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p))
  if (env.tunnel && (has('server/') || has('host/') || has('platform/') || has('plugins/') || has('public/') || has('package.json') || has('package-lock.json') || has('agent/bridge'))) out.push('relayServer')
  if (env.tunnel && has('relay/')) out.push('relayHelper')
  if (has('install.sh') || has('Brewfile')) out.push('install')
  return out
}

export async function update(ctx) {
  const { APP_DIR, CONFIG_PATH, NODE, t, lang, c, say, readJson, writeFileSafe, flag, tildify } = ctx
  const STATE = path.join(path.dirname(CONFIG_PATH), 'update-state.json')
  const TUNNEL_PLIST = path.join(os.homedir(), 'Library/LaunchAgents/local.pane-remote.tunnel.plist')
  const die = (m, code = 1) => { console.error(c.bad(`✗ ${m}`)); process.exit(code) }
  const warn = (m) => say(`  ${c.warn('!')} ${m}`)
  const ok = (m) => say(`  ${c.ok('✓')} ${m}`)
  const g = (a, o) => git(APP_DIR, a, o)
  const cli = (a, o = {}) => spawnSync(NODE, [path.join(APP_DIR, 'lib/cli.mjs'), ...a], { encoding: 'utf8', timeout: 600000, ...o, env: { ...process.env, PANE_REMOTE_LANG: lang, ...(o.env || {}) } })

  if (!g(['--version']).ok) die(t('没有 git：装 Xcode 命令行工具（xcode-select --install）'))
  const top = g(['rev-parse', '--show-toplevel'])
  if (!top.ok || fs.realpathSync(top.out) !== fs.realpathSync(APP_DIR)) die(t('{dir} 不是 git clone 下来的仓库，没法用 update；重新按 README 用 git clone 安装', { dir: tildify(APP_DIR) }))
  const cfg = readJson(CONFIG_PATH, null) || die(t('先跑 pane-remote init'))
  const saveCfg = (patch) => { const cur = readJson(CONFIG_PATH, {}); writeFileSafe(CONFIG_PATH, JSON.stringify({ ...cur, ...patch }, null, 2) + '\n') }
  const env = { tunnel: fs.existsSync(TUNNEL_PLIST), bridgeEnv: fs.existsSync(ctx.BRIDGE_ENV) }

  /** 工作区里被改过的已跟踪文件（未跟踪的单独返回） */
  function dirty() {
    const r = g(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const tracked = [], untracked = []
    const parts = r.raw.split('\0').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], xy = p.slice(0, 2), name = p.slice(3)
      if (xy === '??') untracked.push(name)
      else { tracked.push(`${xy} ${name}`); if (xy[0] === 'R' || xy[0] === 'C') i++ }
    }
    return { tracked, untracked }
  }
  const changedFiles = (a, b) => g(['diff', '--name-only', '--no-renames', '-z', a, b]).raw.split('\0').filter(Boolean)

  function showPreview(from, to, files, undo = false) {
    const log = g(['log', '--no-decorate', '--format=%h %s%x00', `${from}..${to}`]).raw.split('\0').map((s) => s.trim()).filter(Boolean)
    say(c.b(undo ? t('要撤销的提交（{n} 个）：', { n: log.length }) : t('新提交（{n} 个）：', { n: log.length })))
    for (const l of log.slice(0, 50)) say(`  ${clean(l)}`)
    if (log.length > 50) say(c.dim('  ' + t('…还有 {n} 个', { n: log.length - 50 })))
    const AREAS = {
      deps: t('npm 依赖'), server: t('服务端'), public: t('手机网页（构建好的）'), web: t('手机网页源码'), agent: t('电脑端脚本'), host: 'pane-host',
      screen: t('看屏幕模块'), mac: t('mac 模块'), cli: t('命令行'), relay: t('中转模式'), install: t('安装脚本'), docs: t('文档'), other: t('其他'),
    }
    const groups = {}
    for (const f of files) (groups[area(f)] = groups[area(f)] || []).push(f)
    say(c.b(t('改动的文件（{n} 个）：', { n: files.length })))
    for (const k of Object.keys(AREAS)) {
      if (!groups[k]) continue
      say(`  ${AREAS[k]}`)
      for (const f of groups[k].slice(0, 30)) say(c.dim(`    ${clean(f)}`))
      if (groups[k].length > 30) say(c.dim('    ' + t('…还有 {n} 个', { n: groups[k].length - 30 })))
    }
  }
  const STEP_NAMES = {
    deps: t('重装 npm 依赖（和 install.sh 一样的参数）'),
    mousectl: t('重编并重装 mousectl（看屏幕模块）'),
    hooks: t('重新合并 Claude / Codex 的 hook（只动已经装过的）'),
    bridgeEnv: t('重写 bridge.env'),
    restart: t('重启后台服务'),
    host: t('重启 pane-host'),
  }
  function showPlan(steps, nts) {
    say(c.b(t('要做的步骤：')))
    if (!steps.length) say(c.dim('  ' + t('（没有：只是更新文件）')))
    for (const s of steps) say(`  · ${STEP_NAMES[s]}`)
    if (nts.includes('relayServer')) say(`  · ${c.warn(t('中转服务器也要更新（做完后会给出命令）'))}`)
  }

  function confirmOrDie(q) {
    if (flag('--yes')) return Promise.resolve()
    if (!process.stdin.isTTY) die(t('不是在终端里运行：确认要更新就加 --yes'))
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return rl.question(`${q} [y/N] `).then((a) => { rl.close(); if (!/^y/i.test(a.trim())) { say(t('已取消')); process.exit(0) } })
  }

  // ---------- 各个步骤 ----------
  function hasSignIdentity() {
    const r = spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8', timeout: 10000 })
    return (r.stdout || '').includes(`"${SIGN_ID}"`)
  }
  /** 跑一步；返回 true = 成功 */
  async function runStep(step, phase) {
    say(c.b(`→ ${STEP_NAMES[step]}`) + (phase === 'rollback' ? c.dim(t('（旧版本）')) : ''))
    if (TEST_FAIL === step && phase !== 'rollback') { warn(t('（测试）模拟这一步失败')); return false }
    if (step === 'deps') {
      const npm = path.join(path.dirname(NODE), 'npm')
      const a = ['ci', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error']
      if (TEST) { say(c.dim(`  (test) npm ${a.join(' ')}`)); if (cfg.modules?.screen) say(c.dim('  (test) ' + t('看屏幕模块开着：检查 / 补装 sharp'))); return true }
      const r = spawnSync(fs.existsSync(npm) ? npm : 'npm', a, { cwd: APP_DIR, stdio: 'inherit', timeout: 600000, env: { ...process.env, npm_config_update_notifier: 'false', PATH: `${path.dirname(NODE)}:${process.env.PATH || ''}` } })
      if (r.status !== 0) return false
      // npm ci 会清掉 sharp 的可选预编译包：看屏幕模块开着就按 enable screen 的办法补上
      if (cfg.modules?.screen && !ctx.sharpOk() && !ctx.installSharp()) return false
      return true
    }
    if (step === 'mousectl') {
      const identity = TEST ? !!process.env.PANE_REMOTE_UPDATE_TEST_IDENTITY : hasSignIdentity()
      if (!identity) {
        warn(t('钥匙串里没有「{id}」签名证书：安装脚本不会重编已有的 mousectl，新的 mousectl 代码还没生效。', { id: SIGN_ID }))
        warn(t('要用上新代码：pane-remote enable screen --create-cert（建证书后重编；macOS 会再要一次辅助功能和屏幕录制授权，之后的更新不会再掉）'))
      }
      if (TEST) { say(c.dim('  (test) bash agent/screen/install-mousectl.sh')); return true }
      return spawnSync('/bin/bash', [path.join(APP_DIR, 'agent/screen/install-mousectl.sh')], { stdio: 'inherit', timeout: 300000 }).status === 0
    }
    if (step === 'hooks' || step === 'bridgeEnv') {
      // 用（刚换上的）这一版的代码来合并：事件表可能变了
      const r = cli(['refresh', step === 'hooks' ? 'hooks' : 'bridge-env', ...(TEST ? ['--dry-run'] : [])], { stdio: 'inherit' })
      return r.status === 0
    }
    if (step === 'host') {
      if (TEST) { say(c.dim('  (test) launchctl kickstart -k gui/<uid>/local.pane-remote.host')); return true }
      ctx.restartHost()
      ok(t('pane-host 已重启（没装 LaunchAgent 的话，下次用到时自动拉起新版）'))
      return true
    }
    if (step === 'restart') {
      if (cfg.mode === 'relay') { warn(t('这是中转服务器上的配置：自己重启服务（sudo systemctl restart pane-remote）')); return true }
      if (TEST) { say(c.dim('  (test) launchctl kickstart -k gui/<uid>/local.pane-remote.server')); return true }
      if (!ctx.loaded()) { warn(t('后台服务没用 launchd 跑（--skip-service）：自己重启 server/server.mjs')); return true }
      ctx.restartService()
      let st = 0
      for (let i = 0; i < 40 && st !== 200; i++) { await new Promise((r) => setTimeout(r, 300)); st = await ctx.probe(cfg) }
      if (st !== 200) { warn(t('服务重启后没响应（{status}）', { status: st || t('连不上') })); return false }
      ok(t('服务正常响应（127.0.0.1:{port}）', { port: cfg.port }))
      return true
    }
    return false
  }

  /** 跑 doctor，返回失败项列表（null = 拿不到结构化结果，看 exit 字段） */
  function doctor() {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-remote-doctor-')), 'out.json')
    const r = cli(['doctor'], { env: { PANE_REMOTE_DOCTOR_OUT: out }, timeout: 120000 })
    let fails = null
    try { fails = JSON.parse(fs.readFileSync(out, 'utf8')).fails } catch {}
    try { fs.rmSync(path.dirname(out), { recursive: true, force: true }) } catch {}
    return { exit: r.status, fails, output: r.stdout || '' }
  }
  const newFailures = (before, after) => {
    if (after.fails && before.fails) return after.fails.filter((f) => !before.fails.includes(f))
    return after.exit !== 0 && before.exit === 0 ? [t('doctor 退出码 {code}', { code: after.exit })] : []
  }

  async function rollback(prev, cur, steps, saved) {
    say(c.b('\n' + t('回滚到 {rev}…', { rev: prev.slice(0, 7) })))
    const d = dirty()
    if (d.tracked.length) warn(t('更新步骤改动了这些已跟踪文件，回滚会一起还原：{files}', { files: d.tracked.map(clean).join(', ') }))
    // 能走到这里，说明更新前工作区是干净的（有改动早就拒绝了），所以 reset --hard 不会丢用户的东西
    const r = g(['reset', '--hard', '--quiet', prev])
    if (!r.ok) { say(c.bad(t('git reset 失败：{err}', { err: r.err }))); return false }
    ok(t('代码已回到 {rev}', { rev: prev.slice(0, 7) }))
    let good = true
    for (const s of steps) {
      if (s === 'bridgeEnv' && saved?.bridgeEnv != null && !TEST) { writeFileSafe(ctx.BRIDGE_ENV, saved.bridgeEnv); ok(t('bridge.env 已还原')); continue }
      if (!(await runStep(s, 'rollback'))) { good = false; say(c.bad(t('旧版本的这一步也失败了：{step}', { step: STEP_NAMES[s] }))) }
    }
    const st = readJson(STATE, {})
    if (st.last && st.last.to === cur) { st.last.rolledBack = true; writeFileSafe(STATE, JSON.stringify(st, null, 2) + '\n') }
    return good
  }

  function printRelay(nts, from, to) {
    if (nts.includes('relayServer')) {
      say(c.b('\n' + t('中转服务器也要更新（电脑和服务器的版本要一致）。在这台电脑的仓库目录里执行：')))
      const r = spawnSync(NODE, [path.join(APP_DIR, 'relay/relay.mjs'), 'server-update'], { encoding: 'utf8', env: { ...process.env, PANE_REMOTE_LANG: lang } })
      say((r.stdout || '').replace(/\n$/, '') || `  pane-remote relay server-update <user@server>`)
    }
    if (nts.includes('relayHelper')) {
      warn(t('中转模式的辅助命令改了：看一下 {cmd}，隧道参数或 authorized_keys 那一行变了的话，重跑 pane-remote relay tunnel <用户@服务器> / pane-remote relay authorized-key <公钥>', { cmd: `git -C ${tildify(APP_DIR)} diff ${from.slice(0, 7)} ${to.slice(0, 7)} -- relay/` }))
    }
    if (nts.includes('install')) {
      warn(t('install.sh / Brewfile 改了，update 不会重跑它们：看一下 {cmd}，需要的话再跑一次 ./install.sh', { cmd: `git -C ${tildify(APP_DIR)} diff ${from.slice(0, 7)} ${to.slice(0, 7)} -- install.sh Brewfile` }))
    }
  }

  // ---------- --rollback ----------
  if (flag('--rollback')) {
    const last = readJson(STATE, {}).last
    if (!last?.from || !last?.to) die(t('没有可以回滚的更新记录'))
    if (last.rolledBack) die(t('上一次更新（{from} → {to}）已经回滚过了', { from: last.from.slice(0, 7), to: last.to.slice(0, 7) }))
    const head = g(['rev-parse', 'HEAD']).out
    if (head !== last.to) die(t('现在的版本 {head} 不是上一次更新到的 {to}（之后又动过仓库），不自动回滚', { head: head.slice(0, 7), to: last.to.slice(0, 7) }))
    const d = dirty()
    if (d.tracked.length) { say(t('工作区有改动：')); for (const l of d.tracked) say(`  ${clean(l)}`); die(t('先处理掉这些改动（提交或还原）再回滚')) }
    if (!g(['merge-base', '--is-ancestor', last.from, last.to]).ok) die(t('记录里的旧版本 {rev} 不在当前历史上，不自动回滚', { rev: last.from.slice(0, 7) }))
    const files = changedFiles(last.from, last.to)
    const steps = planSteps(files, cfg, env)
    say(c.b(t('回滚上一次更新：{to} → {from}', { from: last.from.slice(0, 7), to: last.to.slice(0, 7) })))
    showPreview(last.from, last.to, files, true)
    showPlan(steps, [])
    await confirmOrDie(t('撤销这些提交？'))
    const good = await rollback(last.from, last.to, steps, last)
    printRelay(notices(files, env), last.to, last.from)
    say(good ? c.ok('\n' + t('已回滚到 {rev}', { rev: last.from.slice(0, 7) })) : c.bad('\n' + t('已回滚代码，但有步骤失败（看上面的输出），跑 pane-remote doctor 看看')))
    process.exit(good ? 0 : 1)
  }

  // ---------- 来源检查 ----------
  const branch = g(['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!branch.ok) die(t('仓库不在任何分支上（detached HEAD），不自动更新'))
  const src = gitSource(APP_DIR)
  if (!src) {
    const url = g(['ls-remote', '--get-url', 'origin']).out
    die(t('只从 https 的 origin 更新：当前分支 {branch} 要跟踪 origin 上的分支，origin 要是不带账号密码的 https 地址（现在是 {url}）', { branch: branch.out, url: clean(url || t('无')) }))
  }
  if (!cfg.updateSource) {
    saveCfg({ updateSource: src })
    ok(t('记下更新来源：{url}（{branch} 分支），以后只从这里更新', { url: clean(src.url), branch: clean(src.branch) }))
  } else if (cfg.updateSource.url !== src.url || cfg.updateSource.branch !== src.branch) {
    die(t('origin 和安装时记下的更新来源不一样，拒绝更新：\n  记下的：{a}\n  现在的：{b}\n确实是你自己改的，就把 {file} 里的 updateSource 改成新的地址和分支', {
      a: clean(`${cfg.updateSource.url} (${cfg.updateSource.branch})`), b: clean(`${src.url} (${src.branch})`), file: tildify(CONFIG_PATH) }))
  }

  // ---------- 拉取 ----------
  say(c.dim(t('拉取 {url} …', { url: clean(src.url) })))
  const f = g(['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(TEST ? ['-c', 'protocol.file.allow=always'] : []), 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin',
    `+refs/heads/${src.branch}:refs/remotes/origin/${src.branch}`], { timeout: 120000 })
  if (!f.ok) die(t('拉取失败：{err}', { err: clean(f.err) }))
  const head = g(['rev-parse', 'HEAD']).out
  const next = g(['rev-parse', `refs/remotes/origin/${src.branch}`]).out
  if (head === next || g(['merge-base', '--is-ancestor', next, head]).ok) {
    say(c.ok('✓ ' + t('已经是最新（{rev}）', { rev: head.slice(0, 7) })))
    if (head !== next) say(c.dim('  ' + t('本地比上游多了提交，没有要拉的')))
    process.exit(0)
  }
  const files = changedFiles(head, next)
  const diverged = !g(['merge-base', '--is-ancestor', head, next]).ok
  const steps = planSteps(files, cfg, env)
  const nts = notices(files, env)
  say(c.b(t('有更新：{from} → {to}', { from: head.slice(0, 7), to: next.slice(0, 7) })))
  showPreview(diverged ? g(['merge-base', head, next]).out : head, next, files)
  showPlan(steps, nts)

  // ---------- 不搞意外 ----------
  const problems = []
  if (diverged) problems.push(t('本地历史和上游分叉了（本地有上游没有的提交），只能快进更新。自己处理好（比如 git log {up}..HEAD 看看）再试', { up: `origin/${src.branch}` }))
  const d = dirty()
  if (d.tracked.length) problems.push(t('工作区有改动，不覆盖：\n{files}\n先提交或还原再更新', { files: d.tracked.map((l) => '    ' + clean(l)).join('\n') }))
  const collide = d.untracked.filter((u) => files.includes(u))
  if (collide.length) problems.push(t('这些未跟踪的文件会被新版本里的同名文件覆盖：{files}；先挪走再更新', { files: collide.map(clean).join(', ') }))
  if (problems.length) {
    for (const p of problems) say(c.bad('✗ ' + p))
    process.exit(flag('--check') ? 10 : 1)
  }
  if (flag('--check')) { say(c.dim(t('运行 pane-remote update 应用'))); process.exit(10) }

  await confirmOrDie(t('应用这次更新？'))

  // ---------- 应用 ----------
  // 下面才开始碰新代码。先记下回滚要用的东西
  const baseline = steps.length ? doctor() : null
  const saved = { from: head, to: next, at: new Date().toISOString(), bridgeEnv: env.bridgeEnv ? fs.readFileSync(ctx.BRIDGE_ENV, 'utf8') : null }
  writeFileSafe(STATE, JSON.stringify({ last: saved }, null, 2) + '\n')
  const m = g(['merge', '--ff-only', '--quiet', next])
  if (!m.ok) die(t('快进合并失败（没改动任何东西）：{err}', { err: clean(m.err) }))
  ok(t('代码已更新到 {rev}', { rev: next.slice(0, 7) }))

  let failed = ''
  for (const s of steps) if (!(await runStep(s, 'apply'))) { failed = s; break }
  let regress = []
  if (!failed && steps.length) {
    say(c.b('→ ' + t('自检（pane-remote doctor）')))
    const after = TEST_FAIL === 'doctor' ? { exit: 1, fails: [...(baseline.fails || []), t('（测试）模拟的新失败项')] } : doctor()
    regress = newFailures(baseline, after)
    if (regress.length) { say(c.bad('  ' + t('比更新前多了这些问题：'))); for (const r of regress) say(c.bad(`    ✗ ${r}`)) }
    else ok(t('没有新问题') + (after.fails?.length ? c.dim(t('（更新前就有的 {n} 项问题还在）', { n: after.fails.length })) : ''))
  }
  if (failed || regress.length) {
    say(c.bad('\n' + (failed ? t('这一步失败了：{step}', { step: STEP_NAMES[failed] }) : t('更新后自检变差了'))))
    // 只重做真正跑过的步骤（含失败的那一步）；自检变差时是全部
    const done = failed ? steps.slice(0, steps.indexOf(failed) + 1) : steps
    const good = await rollback(head, next, done, saved)
    say(good ? c.warn('\n' + t('已自动回滚到 {rev}，一切照旧。上面的输出说明了原因', { rev: head.slice(0, 7) })) : c.bad('\n' + t('已回滚代码，但有步骤失败（看上面的输出），跑 pane-remote doctor 看看')))
    process.exit(1)
  }
  printRelay(nts, head, next)
  say(c.ok('\n' + t('更新完成：{from} → {to}', { from: head.slice(0, 7), to: next.slice(0, 7) })))
  if (steps.includes('restart')) say(c.dim(t('手机上顶栏会亮「更新」按钮，点一下刷新网页')))
  if (steps.includes('hooks')) say(c.dim(t('已经开着的 Claude 会话要重开一次才会用上新 hook')))
  say(c.dim(t('有问题可以 pane-remote update --rollback 回到 {rev}', { rev: head.slice(0, 7) })))
  process.exit(0)
}
