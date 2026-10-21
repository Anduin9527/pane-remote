// 统一会话接口：WezTerm pane 和 Cursor 会话合在一个列表里。
// 各自的数据还在原来的地方（pane = session.svelte.ts，Cursor = cursor/cursor.svelte.ts），这里只做适配：
// 列出、当前选中、标题、状态、send、stop。顶栏、会话列表、待办都只认这一层。
import { label, sendRaw } from './api'
import { ui, paneName } from './session.svelte'
import { cur, cursorSummary, cursorCmd, sessionById } from './cursor/cursor.svelte'
import { route, type View } from './router.svelte'
import { t } from './i18n'

export type SessionKind = 'pane' | 'cursor'
export type SessionStatus = 'waiting' | 'running' | 'done' | 'idle' | 'error'
export type SessionItem = {
  kind: SessionKind
  /** pane 号 / Cursor 会话 id */
  id: string
  /** 路由里的写法：p12 / c:<id> */
  key: string
  title: string
  /** 第二行：pane 的目录和尺寸、Cursor 的状态 */
  detail: string
  /** 分组：pane = 窗口 / 标签页，Cursor = 项目 */
  group: string
  status: SessionStatus
  unread: boolean
  /** 等你操作时的提示文字 */
  prompt: string
}

export interface SessionSource {
  kind: SessionKind
  list(): SessionItem[]
  /** 当前选中的会话 id（没有就是 null） */
  current(): string | null
  title(): string
  status(id?: string | null): SessionStatus
  /** 发一条消息并提交（对话方式）；终端的逐字输入、快捷键还是走 Composer / KeyBar */
  send(text: string): Promise<void>
  /** 让正在跑的 agent 停下 */
  stop(): Promise<void>
  view(id: string): View
}

export const paneSessions: SessionSource = {
  kind: 'pane',
  list: () => ui.panes.map((p) => {
    const s = ui.states[p.pane]
    return {
      kind: 'pane', id: String(p.pane), key: `p${p.pane}`, title: `#${p.pane} ${label(p)}`, detail: `${p.cwd}  ${p.cols}×${p.rows}`,
      group: t('窗口 {w}', { w: p.window }), status: s?.state || 'idle', unread: !!s?.unread, prompt: s?.prompt || '',
    }
  }),
  current: () => ui.current,
  title: () => paneName(),
  status: (id = ui.current) => (id && ui.states[id]?.state) || 'idle',
  async send(text) {
    const pane = ui.current
    if (!pane) throw new Error(t('选择 pane'))
    sendRaw(pane, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text, false)
    sendRaw(pane, '\r', false)
  },
  // agent（Claude Code / Codex / cursor-agent）按 Esc 中断；普通 shell 发 Ctrl-C
  async stop() { if (ui.current) sendRaw(ui.current, ui.agent ? '\x1b' : '\x03', false) },
  view: (id) => ({ kind: 'pane', pane: id }),
}

// Cursor 的状态文字（Completed / In progress / Needs review…）→ 统一状态
function cursorStatus(st: string, waiting?: boolean): SessionStatus {
  if (waiting || /approv|review|input|wait|permission/i.test(st)) return 'waiting'
  if (/in progress|generat|running/i.test(st)) return 'running'
  if (/error|fail/i.test(st)) return 'error'
  if (/complete/i.test(st)) return 'done'
  return 'idle'
}

export const cursorSessions: SessionSource = {
  kind: 'cursor',
  list: () => cur.projects.flatMap((p) => p.sessions.map((s) => ({
    kind: 'cursor' as const, id: s.id, key: `c:${s.id}`, title: s.title || t('无标题'), detail: s.age,
    group: p.label, status: cursorStatus(s.status, s.waiting), unread: !!s.unread, prompt: '',
  }))),
  current: () => cur.id || null,
  title: () => {
    if (cur.draftProject) return t('新会话 · {project}', { project: cur.projects.find((p) => p.id === cur.draftProject)?.label || t('不选项目') })
    return sessionById(cur.id)?.title || cur.name || (cur.id ? t('未命名会话') : 'Cursor')
  },
  status: (id = cur.id) => {
    if (id === cur.id && cur.generating) return 'running'
    const s = id ? sessionById(id) : null
    return s ? cursorStatus(s.status, s.waiting || cursorSummary.waiting.some((w) => w.id === id)) : 'idle'
  },
  async send(text) {
    if (cur.draftProject) await cursorCmd('new', { project: cur.draftProject === '__new__' ? '' : cur.draftProject, text })
    else await cursorCmd('send', { id: cur.id, text })
  },
  async stop() { await cursorCmd('stop') },
  view: (id) => ({ kind: 'cursor', id }),
}

export const sources: Record<SessionKind, SessionSource> = { pane: paneSessions, cursor: cursorSessions }

/** 当前地址对应的会话来源；在插件页时是 null */
export const activeSource = (): SessionSource | null => (route.view.kind === 'cursor' ? cursorSessions : route.view.kind === 'plugin' ? null : paneSessions)

/** 等你操作的会话总数（pane + Cursor），exceptCurrent = 不算正在看的那个 */
export function waitingCount(exceptCurrent = false) {
  const v = route.view
  const panes = Object.entries(ui.states).filter(([id, s]) => s.state === 'waiting' && !(exceptCurrent && v.kind === 'pane' && id === ui.current)).length
  const cursor = cursorSummary.waiting.filter((w) => !(exceptCurrent && v.kind === 'cursor' && w.id === cur.id)).length
  return panes + cursor
}
