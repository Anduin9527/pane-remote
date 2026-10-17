import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { report } from '$lib/api'

// 报错发回服务端，方便排查手机上的问题（journalctl -u pane-relay | grep client）
addEventListener('error', (e) => report('error', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno} ${e.error?.stack || ''}`))
addEventListener('unhandledrejection', (e) => report('rejection', e.reason?.stack || e.reason?.message || e.reason))
const build = (document.querySelector('script[src*="assets/index-"]') as HTMLScriptElement | null)?.src.split('/').pop() || 'dev'
declare const __BUILD_TIME__: string
report('boot', `v2 ${build} ${__BUILD_TIME__} ${innerWidth}x${innerHeight} dpr=${devicePixelRatio} standalone=${(navigator as any).standalone}`)

// iOS Safari 无视 user-scalable=no，双指缩放要自己拦；键盘收起后页面偶尔停在被推上去的位置，拉回来
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false })
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault() }, { passive: false })
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) window.scrollTo(0, 0) }, 50))

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})

// 检查新版本：切回前台、每 10 分钟拉一次首页，资源文件名（带内容哈希）变了就提示刷新。
// iOS 主屏幕 App 从后台回来不会重新加载页面，不提示的话会一直停在旧版。
let notified = false
async function checkUpdate() {
  if (notified || build === 'dev' || document.visibilityState !== 'visible') return
  try {
    const html = await (await fetch('./', { cache: 'no-store' })).text()
    const latest = html.match(/assets\/(index-[^"]+\.js)/)?.[1]
    if (latest && latest !== build) {
      notified = true
      const { toast } = await import('svelte-sonner')
      toast('有新版本', { duration: Infinity, action: { label: '刷新', onClick: () => location.reload() } })
    }
  } catch {}
}
document.addEventListener('visibilitychange', checkUpdate)
setInterval(checkUpdate, 10 * 60000)
setTimeout(checkUpdate, 5000)

const app = mount(App, { target: document.getElementById('app')! })
;(window as any).__mounted = true // index.html 里的保底脚本据此判断页面有没有显示出来
export default app
