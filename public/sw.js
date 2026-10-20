// 只负责推送通知，不拦截、不缓存任何请求：页面永远走网络（浏览器自己的 HTTP 缓存照常生效）。
// 以前做过离线缓存，部署后多次导致主屏幕 App 白屏，所以去掉了；激活时把那时留下的缓存全部清掉。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== 'pane-lang') await caches.delete(k) // pane-lang：页面写的界面语言，推送标题要用
    await self.clients.claim()
  })())
})

// ---------- 推送 ----------
// 推送文案是服务端写的中文；手机界面是英文时（页面把语言写进 pane-lang 缓存）在这里翻译固定的几种
const PUSH_EN = {
  '测试通知：能看到这条说明推送通了': 'Test notification: if you can see this, push works',
  '电脑要打开一个网页': 'Your computer wants to open a web page',
  '做完了': 'Finished', '出错停下了': 'Stopped with an error', '等你操作': 'Needs your input',
  '轮到你了': 'Your turn', '需要你确认': 'Needs your confirmation',
  'Cursor 做完了': 'Cursor finished', 'Cursor 在等你': 'Cursor is waiting for you', '一个 Agent 会话': 'An agent session',
}
const PUSH_SUFFIX_EN = [[' 做完了', ' finished'], [' 出错停下了', ' stopped with an error'], [' 等你操作', ' needs your input'], [' 问你', ' asks you'], [' 要你确认', ' needs your OK']]
// 问题报告的标题是「前缀：问题」
const PUSH_PREFIX_EN = [['pane-remote 发现问题：', 'pane-remote found a problem: '], ['问题又出现了：', 'Problem is back: '], ['修好了：', 'Fixed: '], ['没修成：', 'Fix failed: '], ['修复要你确认：', 'Fix needs your OK: '], ['不打算修：', "Won't fix: "]]
async function pushLang() {
  try { const r = await (await caches.open('pane-lang')).match('lang'); if (r) return await r.text() } catch {}
  return /^zh\b/i.test(self.navigator.language || '') ? 'zh' : 'en'
}
function pushEn(s) {
  if (!s) return s
  if (PUSH_EN[s]) return PUSH_EN[s]
  for (const [zh, en] of PUSH_SUFFIX_EN) if (s.endsWith(zh)) return s.slice(0, -zh.length) + en
  for (const [zh, en] of PUSH_PREFIX_EN) if (s.startsWith(zh)) return en + s.slice(zh.length)
  return s
}
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { d = { title: 'Pane Remote', body: e.data && e.data.text() } }
  e.waitUntil((async () => {
    if ((await pushLang()) === 'en') { d.title = pushEn(d.title); d.body = pushEn(d.body) }
    await self.registration.showNotification(d.title || 'Pane Remote', {
    body: d.body || '', tag: d.tag || 'pane', renotify: true,
    icon: 'icon-180.png', badge: 'icon-180.png', data: { pane: d.pane, url: d.url, cursor: d.cursor, incident: d.incident },
    })
  })())
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const pane = e.notification.data && e.notification.data.pane
  const open = e.notification.data && e.notification.data.url // 电脑要打开的网页：进预览页打开
  const cursor = e.notification.data && e.notification.data.cursor // Cursor 会话：进 Cursor 页打开这个会话
  const incident = e.notification.data && e.notification.data.incident // 问题报告：打开那一条
  const url = new URL(incident ? `./?incident=${encodeURIComponent(incident)}` : cursor ? `./?cursor=${encodeURIComponent(cursor)}` : open ? `./?preview=${encodeURIComponent(open)}` : pane != null ? `./?pane=${pane}` : './', self.registration.scope).href
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of list) {
      if (incident) c.postMessage({ type: 'open-incident', id: incident })
      else if (cursor) c.postMessage({ type: 'open-cursor', id: cursor })
      else if (open) c.postMessage({ type: 'open-preview', url: open })
      else if (pane != null) c.postMessage({ type: 'open-pane', pane })
      return c.focus()
    }
    return self.clients.openWindow(url)
  })())
})
