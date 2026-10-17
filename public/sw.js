// 只负责推送通知，不拦截、不缓存任何请求：页面永远走网络（浏览器自己的 HTTP 缓存照常生效）。
// 以前做过离线缓存，部署后多次导致主屏幕 App 白屏，所以去掉了；激活时把那时留下的缓存全部清掉。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k)
    await self.clients.claim()
  })())
})

// ---------- 推送 ----------
self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data.json() } catch { d = { title: 'Pane Remote', body: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(d.title || 'Pane Remote', {
    body: d.body || '', tag: d.tag || 'pane', renotify: true,
    icon: 'icon-180.png', badge: 'icon-180.png', data: { pane: d.pane, url: d.url },
  }))
})
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const pane = e.notification.data && e.notification.data.pane
  const open = e.notification.data && e.notification.data.url // 电脑要打开的网页：进预览页打开
  const url = new URL(open ? `./?preview=${encodeURIComponent(open)}` : pane != null ? `./?pane=${pane}` : './', self.registration.scope).href
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of list) {
      if (open) c.postMessage({ type: 'open-preview', url: open })
      else if (pane != null) c.postMessage({ type: 'open-pane', pane })
      return c.focus()
    }
    return self.clients.openWindow(url)
  })())
})
