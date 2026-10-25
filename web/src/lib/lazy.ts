// 懒加载的页面 / 面板模块：网络断了的那一下 import() 会失败（Safari：Importing a module script failed），
// 以前 {#await} 就一直停在空白，只能把 App 划掉重开。这里失败后等网络回来（online、回到前台、或者过几秒）再试，
// 一直等下去，不往外抛（不算未处理的 Promise，不当问题上报）。
// 网络已经通了还是失败：多半是浏览器记住了那次失败的模块（重试拿不到），或者部署后旧文件没了，重新载入页面一次（60 秒内最多一次）。
import { report } from '$lib/api'

const RELOAD_KEY = 'pr-lazy-reload'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等到「可能有网了」：online 事件、回到前台，最多等 ms */
function nextChance(ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); removeEventListener('online', done); document.removeEventListener('visibilitychange', vis); resolve() }
    const vis = () => { if (document.visibilityState === 'visible') done() }
    const t = setTimeout(done, ms)
    addEventListener('online', done)
    document.addEventListener('visibilitychange', vis)
  })
}

async function serverReachable() {
  try { return (await fetch('api/version', { cache: 'no-store', signal: AbortSignal.timeout(5000) })).ok } catch { return false }
}

function reloadOnce() {
  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0 } catch {}
  if (Date.now() - last < 60000) return false
  try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch {}
  location.reload()
  return true
}

/** 载入模块，失败就等网络回来再试，直到成功 */
export async function load<T>(fn: () => Promise<T>): Promise<T> {
  let fails = 0
  for (;;) {
    try {
      const m = await fn()
      if (fails) report('lazy-ok', `loaded after ${fails} failures`)
      return m
    } catch (e) {
      fails++
      if (fails === 1) report('lazy-retry', `${(e as Error)?.message || e} online=${navigator.onLine}`)
      // 连着失败了几次而服务器其实连得上：重试没用了，重新载入页面
      if (fails >= 3 && (await serverReachable()) && reloadOnce()) return new Promise<T>(() => {})
      await nextChance(Math.min(15000, 1000 * 2 ** Math.min(fails, 4)))
      if (document.visibilityState !== 'visible') await nextChance(3600e3) // 在后台就不白试，等回到前台
      await sleep(200)
    }
  }
}
