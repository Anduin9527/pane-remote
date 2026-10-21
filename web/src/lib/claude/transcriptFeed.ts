// 对话视图的数据来源：优先订阅 api/transcript/stream（电脑上的 pane-host 盯着会话记录，有变化才推增量），
// 订阅不了（pane-host 不在线回 503）或中途断了，就回到每 2 秒轮询 api/transcript（带 ETag），隔一阵再试订阅。
// 页面切到后台时两样都停，回到前台重新来（订阅先拿一份全量）
type Delta<T> = { seq: number; drop: number; keep: number; tail: T[] }

// 每个 pane 上次的 ETag（模块级，组件重建也在）
const etags = ((globalThis as any).__chatEtags ??= new Map<string, string>()) as Map<string, string>

export function followTranscript<T>(pane: string, n: number, on: { messages: (list: T[]) => void; error: (msg: string) => void }) {
  let stopped = false
  let es: EventSource | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let list: T[] | null = null
  let seq = 0

  async function poll() {
    if (stopped || document.visibilityState !== 'visible') return
    try {
      const tag = etags.get(pane)
      const r = await fetch(`api/transcript?pane=${pane}&n=${n}`, { cache: 'no-store', headers: tag && list ? { 'if-none-match': tag } : {} })
      if (stopped) return
      if (r.status === 304) return on.messages(list!)
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
      const d: T[] = await r.json()
      if (stopped) return
      const et = r.headers.get('etag')
      if (et) etags.set(pane, et)
      list = d
      on.messages(d)
    } catch (e) {
      if (!stopped) on.error((e as Error).message)
    }
  }
  function startPolling(retryIn: number) {
    es?.close()
    es = null
    if (!pollTimer) { poll(); pollTimer = setInterval(poll, 2000) }
    clearTimeout(retryTimer)
    retryTimer = setTimeout(startStream, retryIn)
  }
  function startStream() {
    if (stopped || document.visibilityState !== 'visible') return
    es?.close()
    let got = false
    const s = new EventSource(`api/transcript/stream?pane=${pane}&n=${n}`)
    es = s
    s.addEventListener('full', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { seq: number; messages: T[] }
      got = true
      clearInterval(pollTimer)
      pollTimer = undefined
      etags.delete(pane) // 轮询那边的 ETag 和推来的不是一份，回到轮询时整份重拉
      list = d.messages
      seq = d.seq
      on.messages(list)
    })
    s.addEventListener('delta', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as Delta<T>
      // 序号接不上、或者和手里的对不上：重连拿全量
      if (!list || d.seq !== seq + 1 || d.drop + d.keep > list.length) return startStream()
      list = list.slice(d.drop, d.drop + d.keep).concat(d.tail)
      seq = d.seq
      on.messages(list)
    })
    // pane-host 断了：服务端推 down 后结束。先轮询，10 秒后再试
    s.addEventListener('down', () => startPolling(10000))
    // 连不上（503 = pane-host 不在线）或断线：EventSource 自己的重连不要，轮询兜底，30 秒后（拿到过数据的话 3 秒后）再试
    s.onerror = () => { if (es === s) startPolling(got ? 3000 : 30000) }
  }
  function onVisible() {
    if (document.visibilityState === 'visible') { if (!es) startStream() }
    else { es?.close(); es = null; clearInterval(pollTimer); pollTimer = undefined; clearTimeout(retryTimer) }
  }
  document.addEventListener('visibilitychange', onVisible)
  startStream()
  return () => {
    stopped = true
    es?.close()
    clearInterval(pollTimer)
    clearTimeout(retryTimer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
