// Cursor 映射的手机端数据：连 /api/cursor/stream，拿连接状态、项目 / 会话列表、当前会话的消息（快照 + 增量）
export type CSession = { id: string; title: string; age: string; status: string; active: boolean; unread?: boolean; waiting?: boolean; choices?: string[] }
export type CProject = { id: string; label: string; uri: string; sessions: CSession[] }
export type CMsg =
  | { id: string; role: 'user' | 'assistant'; text: string; ts: number }
  | { id: string; role: 'tool'; tool: string; detail: string; status: string; decision: string; ts: number; output?: string; cwd?: string; rejected?: boolean; error?: string }
  | { id: string; role: 'thinking'; size: number; ts: number }
export type Conn = 'connecting' | 'not-running' | 'no-debug' | 'launching' | 'ready' | 'error'

export const cur = $state({
  conn: 'connecting' as Conn,
  msg: '',
  step: 0 as number | undefined,
  projects: [] as CProject[],
  active: '', // Cursor 里当前打开的会话
  id: (() => { try { return localStorage.getItem('cursorSession') || '' } catch { return '' } })(), // 手机上在看的会话
  draftProject: '', // 新建会话：还没发第一条消息时的目标项目
  list: [] as CMsg[],
  name: '',
  status: '',
  generating: false,
  choices: [] as string[],
  streamText: '',
  streamId: '',
  loaded: false,
  busy: '',
  path: '', // 会话的项目目录（电脑上）
  changed: 0, // 会话改过的文件数
})

// 每个会话最近一份消息（内存里，最多 10 个）：切回来立刻显示，后台再更新
const msgCache = new Map<string, { list: CMsg[]; name: string }>()
function remember(id: string) {
  if (!id || !cur.list.length) return
  msgCache.delete(id)
  msgCache.set(id, { list: cur.list, name: cur.name })
  while (msgCache.size > 10) msgCache.delete(msgCache.keys().next().value!)
}

// 待办 / 未读汇总：给顶栏的「N 待办」、Cursor 按钮角标、待办收件箱用。在哪个模式都拉（4 秒一次，服务端直接回缓存）
export type CWaiting = { id: string; title: string; project: string; choices: string[]; status: string }
export const cursorSummary = $state({ waiting: [] as CWaiting[], unread: 0 })
export async function pollCursorSummary() {
  if (document.visibilityState !== 'visible') return
  try {
    const r = await fetch('api/cursor/summary', { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    cursorSummary.waiting = d.waiting || []
    cursorSummary.unread = d.unread || 0
  } catch {}
}
setInterval(pollCursorSummary, 4000)
pollCursorSummary()

export const sessionById = (id: string) => cur.projects.flatMap((p) => p.sessions).find((s) => s.id === id)

let es: EventSource | null = null
let wanted = false
export function connectCursor() {
  wanted = true
  es?.close()
  const src = new EventSource(`api/cursor/stream${cur.id ? `?id=${encodeURIComponent(cur.id)}` : ''}`)
  es = src
  const on = (ev: string, fn: (d: any) => void) => src.addEventListener(ev, (e) => fn(JSON.parse((e as MessageEvent).data)))
  on('status', (d) => { cur.conn = d.conn; cur.msg = d.msg || ''; cur.step = d.step })
  on('sessions', (d) => {
    cur.projects = d.projects || []
    const prev = cur.active
    cur.active = d.active || ''
    // 刚在手机上新建的会话：Cursor 里切到了新会话，就跟过去
    if (cur.draftProject && cur.active && cur.active !== prev) { cur.draftProject = ''; selectSession(cur.active) }
  })
  on('messages', (d) => {
    if (d.id !== cur.id) return
    cur.list = d.list || []; cur.name = d.name || ''; apply(d); cur.loaded = true
    remember(d.id)
  })
  on('delta', (d) => {
    if (d.id !== cur.id) return
    const byId = new Map(cur.list.map((m) => [m.id, m]))
    for (const u of d.upserts || []) byId.set(u.id, u)
    cur.list = (d.order || cur.list.map((m) => m.id)).map((k: string) => byId.get(k)).filter(Boolean) as CMsg[]
    apply(d)
    remember(d.id)
  })
}
function apply(d: any) {
  if (d.path !== undefined) cur.path = d.path || ''
  if (d.changed !== undefined) cur.changed = d.changed || 0
  cur.status = d.status || ''
  cur.generating = !!d.generating
  cur.choices = d.choices || []
  cur.streamText = d.streamText || ''
  cur.streamId = d.streamId || ''
}
/** 手动重连：重建推送连接，让电脑那边重新报一遍状态 */
export function reconnectCursor() { if (wanted) connectCursor(); cursorCmd('refresh').catch(() => {}) }
export function disconnectCursor() { wanted = false; es?.close(); es = null }
document.addEventListener('visibilitychange', () => {
  if (!wanted) return
  if (document.visibilityState === 'hidden') { es?.close(); es = null } else if (!es || es.readyState === EventSource.CLOSED) connectCursor()
})

export function selectSession(id: string) {
  remember(cur.id)
  cur.id = id
  cur.draftProject = ''
  const hit = msgCache.get(id)
  cur.list = hit?.list || []; cur.name = hit?.name || ''; cur.loaded = !!hit; cur.streamText = ''; cur.choices = []; cur.path = ''; cur.changed = 0
  try { localStorage.setItem('cursorSession', id) } catch {}
  if (wanted) connectCursor()
}
export function startDraft(project: string) {
  remember(cur.id)
  cur.id = ''; cur.draftProject = project || '__new__'
  cur.list = []; cur.name = ''; cur.loaded = true; cur.streamText = ''; cur.choices = []
  if (wanted) connectCursor()
}

export async function cursorCmd(t: string, body: Record<string, unknown> = {}) {
  cur.busy = t
  try {
    const r = await fetch('api/cursor/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t, ...body }) })
    const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
    if (!d.ok) throw new Error(d.error || '失败')
    return d
  } finally { cur.busy = '' }
}
