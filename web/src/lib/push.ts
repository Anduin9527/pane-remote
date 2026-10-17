// Web Push 订阅。iOS 只有「添加到主屏幕」后从图标打开的页面才能订阅推送（iOS 16.4+）
import { postJson, report } from './api'

export const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const isStandalone = () => (navigator as any).standalone || matchMedia('(display-mode: standalone)').matches

function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

/** 当前这台手机是否已订阅；服务端丢了订阅就顺手补登记 */
export async function pushStatus(): Promise<boolean> {
  if (!pushSupported) return false
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub || Notification.permission !== 'granted') return false
  const on = (await postJson('api/push/status', { endpoint: sub.endpoint }).catch(() => ({}))).subscribed === true
  if (on) return true
  return postJson('api/push/subscribe', { subscription: sub.toJSON() }).then(() => true, () => false)
}

export async function pushEnable(): Promise<boolean> {
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return false
    const reg = await navigator.serviceWorker.ready
    const { key } = await (await fetch('api/push/key')).json()
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }))
    await postJson('api/push/subscribe', { subscription: sub.toJSON() })
    return pushStatus()
  } catch (e) {
    report('push-subscribe', (e as Error).stack || (e as Error).message)
    throw e
  }
}

export async function pushDisable() {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await postJson('api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe()
  }
}

export const pushTest = () => postJson<{ sent: number; failed: number }>('api/push/test')

export const getPushPrefs = async (): Promise<{ stop: boolean }> => (await fetch('api/push/prefs', { cache: 'no-store' })).json()
export const setPushPrefs = (p: { stop: boolean }) => postJson<{ stop: boolean }>('api/push/prefs', p)
