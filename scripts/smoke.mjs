#!/usr/bin/env node
// 冒烟测试：改了前端 / 服务端、部署之前跑，不过就别部署。
// 在本机起一个测试用的服务端（local 模式、临时配置和数据目录、TEST_LOGIN、假 Host 的 pane-host），用 headless Chrome 打开手机页面，逐项检查：
//   外壳能启动、页面没有未捕获的异常、没有客户端问题报告；顶号（两个标签页互顶）；WebSocket / EventSource 的包装还是原生对象
//   （noVNC 按原型查属性）；终端页、插件页（运行时载入）、待办能记一条和「会话任务」一栏
// 看屏幕、Cursor 是可选模块，测试配置里不开（会连真的屏幕共享 / Cursor），对应检查跳过。不往真实的 pane 里发任何东西。
//   node scripts/smoke.mjs            （需要先 cd web && npm run build；Chrome 默认在 /Applications，CHROME=… 可改）
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = Number(process.env.SMOKE_PORT || 18799)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-smoke-'))
const HOSTDIR = fs.mkdtempSync('/tmp/prs-') // unix socket 路径不能太长
let failed = 0
const results = []
const ok = (cond, name, extra = '') => { results.push([!!cond, name]); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra && !cond ? `：${extra}` : ''}`); if (!cond) failed++ }


// ---------- 测试用服务端（local 模式：bridge 和 pane-host 都在本机，pane-host 用假的 Host） ----------
const CONF_DIR = path.join(TMP, 'config')
fs.mkdirSync(CONF_DIR, { recursive: true })
fs.writeFileSync(path.join(CONF_DIR, 'config.json'), JSON.stringify({
  mode: 'local', port: PORT, allowedLogins: ['smoke@test'], serveHosts: ['127.0.0.1'], dataDir: path.join(TMP, 'data'),
  modules: { preview: false, openUrl: false, cursor: false, screen: false, mac: false, plugins: true },
}))
fs.writeFileSync(path.join(CONF_DIR, 'bridge.env'), `NODE=${process.execPath}\n`)
const relayLog = path.join(TMP, 'server.log')
const relay = spawn(process.execPath, [path.join(ROOT, 'server/server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PANE_REMOTE_CONFIG: path.join(CONF_DIR, 'config.json'), TEST_LOGIN: 'smoke@test', ALLOW_HOST_ACCESS: '1', PANE_HOST_DIR: HOSTDIR, PANE_HOST_IMPL: path.join(ROOT, 'host/test/fake-host.mjs'), PANE_REMOTE_STATE: path.join(TMP, 'state'), PANE_HOST_IDLE_EXIT_MS: '60000' },
  stdio: ['ignore', fs.openSync(relayLog, 'w'), fs.openSync(relayLog, 'a')],
})
let chrome = null
async function cleanup() {
  try { chrome?.kill() } catch {} // ignore: 已经退了
  try { relay.kill() } catch {} // ignore: 已经退了
  // 测试里拉起的 pane-host：按 socket 问出 PID，确认是 host/main.mjs 再结束（不碰你自己在跑的 pane-host）
  try {
    const pid = Number(execFileSync('/usr/sbin/lsof', ['-t', path.join(HOSTDIR, 'host.sock')]).toString().trim().split('\n')[0])
    if (pid && execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)]).toString().includes('host/main.mjs')) process.kill(pid, 'SIGTERM')
  } catch {} // ignore: pane-host 已经退了
  await sleep(200)
  fs.rmSync(HOSTDIR, { recursive: true, force: true })
  if (!failed) fs.rmSync(TMP, { recursive: true, force: true })
}

try {
  for (let i = 0; i < 50; i++) { await sleep(200); try { if ((await fetch(`${BASE}/api/version`)).ok) break } catch {} }
  ok((await fetch(`${BASE}/api/version`).then((r) => r.json()).catch(() => ({}))).version, '服务端能启动')

  // ---------- Chrome ----------
  const profile = path.join(TMP, 'chrome')
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--window-size=430,900', 'about:blank'], { stdio: 'ignore' })
  let port
  for (let i = 0; i < 50 && !port; i++) { await sleep(200); try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {} }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const pend = new Map()
  const exceptions = [] // 所有页面（含插件 iframe）里未捕获的异常
  const sockets = [] // 页面开的 WebSocket
  const requests = [] // 页面发的请求
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description?.split('\n')[0] || m.params.exceptionDetails.text)
    else if (m.method === 'Network.webSocketCreated') sockets.push(m.params.url)
    else if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
    else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') {
      const s = m.params.sessionId
      cdp('Runtime.enable', {}, s).catch(() => {})
      cdp('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {})
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
  const cdp = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })) }).then((m) => { if (m.error) throw new Error(`${method}: ${m.error.message}`); return m.result })
  async function openTab(hash = '') {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
    await cdp('Runtime.enable', {}, sessionId)
    await cdp('Network.enable', {}, sessionId)
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
    await cdp('Page.navigate', { url: `${BASE}/${hash}` }, sessionId)
    return sessionId
  }
  const ev = async (s, expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value
  const goto = async (s, hash) => { await ev(s, `location.hash = ${JSON.stringify(hash)}`); await sleep(2500); if (process.env.SMOKE_DEBUG) console.log('DBG after', hash, 'kicked=', await ev(s, `!!document.querySelector('[role=alertdialog]')`)) }
  const clientProblems = () => fs.readFileSync(relayLog, 'utf8').split('\n').filter((l) => /\[client\]/.test(l) && /"kind":"(error|rejection|ui-fail)"/.test(l))

  // 1. 外壳
  const A = await openTab()
  await sleep(4000)
  ok(await ev(A, `!!document.querySelector('#app, body > div') && document.body.innerText.length > 0`), '外壳能渲染')
  ok(await ev(A, `!document.querySelector('[role=alertdialog]')`), '打开后在用（没有被当成被顶 / 本机）')

  // 2. WebSocket / EventSource 包装：还是原生对象，带客户端编号
  const w = await ev(A, `(() => {
    const need = ['binaryType', 'protocol', 'readyState', 'close', 'send', 'onerror', 'onmessage', 'onopen', 'onclose']
    const s = new WebSocket(new URL('api/smoke-ws', location.href).href.replace(/^http/, 'ws'))
    const props = [...Object.keys(s), ...Object.getOwnPropertyNames(Object.getPrototypeOf(s))]
    const r = { missing: need.filter((p) => !props.includes(p)), inst: s instanceof WebSocket && WebSocket.OPEN === 1, pc: s.url.includes('_pc=') }
    s.close()
    const es = new EventSource('api/smoke-es'); r.es = es instanceof EventSource && EventSource.CLOSED === 2 && es.url.includes('_pc='); es.close()
    return r })()`)
  ok(!w.missing.length, 'WebSocket 包装过得了 noVNC 的原型检查', w.missing.join(','))
  ok(w.inst && w.es, 'instanceof 和常量照旧')
  ok(w.pc, 'WebSocket / EventSource 带客户端编号')

  // 3. 各个页面
  await goto(A, '#/s/p999999') // 不存在的 pane：只看页面能不能起来，不读真实终端
  ok(await ev(A, `document.body.innerText.length > 0`), '终端页能打开')
  console.log('SKIP 看屏幕、Cursor（可选模块，测试配置里没开）')
  await goto(A, '#/plugin/hello')
  await sleep(1500)
  const { targetInfos } = await cdp('Target.getTargets')
  const hello = targetInfos.find((t) => t.url.includes('/plugins/hello/'))
  ok(!!hello, '插件页（iframe）打开了')
  if (hello) {
    const { sessionId: H } = await cdp('Target.attachToTarget', { targetId: hello.targetId, flatten: true })
    ok(await ev(H, `typeof utools === 'object' && typeof whatevertools === 'object' && typeof utools.dbStorage.getItem === 'function'`), '插件运行时载入了（utools / whatevertools）')
  }
  await goto(A, '#/plugin/todo')
  await sleep(1500)
  const todo = (await cdp('Target.getTargets')).targetInfos.find((t) => t.url.includes('/plugins/todo/'))
  if (todo) {
    const { sessionId: D } = await cdp('Target.attachToTarget', { targetId: todo.targetId, flatten: true })
    await ev(D, `(() => { const i = document.getElementById('addInput'); i.value = '冒烟测试'; i.dispatchEvent(new Event('input')); document.getElementById('addForm').requestSubmit() })()`)
    await sleep(500)
    ok(/冒烟测试/.test(await ev(D, `document.getElementById('list').innerText`)), '待办能记一条')
    await ev(D, `[...document.querySelectorAll('#status button')].find((b) => b.dataset.v === 'cc').click()`)
    await sleep(800)
    ok(await ev(D, `document.getElementById('addForm').hidden && !!document.getElementById('list').firstChild`), '待办的「会话任务」一栏能打开')
    await ev(D, `[...document.querySelectorAll('#status button')].find((b) => b.dataset.v === 'active').click()`)
  } else ok(false, '待办插件打开了')

  // 4. 顶号：第二个标签页打开，第一个显示被顶；第一个点继续顶回来
  const B = await openTab()
  await sleep(4000)
  let kicked = false
  for (let i = 0; i < 20 && !kicked; i++) { kicked = await ev(A, `!!document.querySelector('[role=alertdialog] button')`); if (!kicked) await sleep(250) }
  ok(kicked, '顶号：后打开的把先打开的顶掉')
  await ev(A, `document.querySelector('[role=alertdialog] button')?.click()`)
  await sleep(4000)
  ok(await ev(A, `!document.querySelector('[role=alertdialog]')`) && await ev(B, `!!document.querySelector('[role=alertdialog] button')`), '顶号：点继续可以顶回来')

  // 5. 全程的报错
  const ex = exceptions.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e))
  ok(!ex.length, '页面没有未捕获的异常', ex.slice(0, 3).join(' | '))
  const cp = clientProblems()
  ok(!cp.length, '没有客户端问题报告', cp.slice(0, 2).map((l) => l.slice(l.indexOf('{'), l.indexOf('{') + 160)).join(' | '))
} catch (e) {
  ok(false, '冒烟测试本身出错', e.stack || e.message)
} finally {
  await cleanup()
}
console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `；日志在 ${TMP}` : ''}`)
process.exit(failed ? 1 : 0)
