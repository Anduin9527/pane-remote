// 问题报告（服务端 incidents.mjs）：顶栏的数字每 30 秒拉一次；打开面板时拉完整列表
import { postJson } from './api'

export type IncidentFix = { mode?: 'bound' | 'new'; state?: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; pane?: number; agent?: string; last?: FixUpdate }
export type FixUpdate = { t: number; status: string; note?: string; branch?: string; pr?: string }
export type IncidentSummary = {
  id: string; title: string; source: 'server' | 'phone' | 'mac' | 'agent' | 'user'; component: string; kind: string; severity: 'high' | 'normal' | 'low'
  count: number; first: number; last: number; status: 'open' | 'fixing' | 'fixed' | 'resolved' | 'ignored'; muted: boolean; fix: IncidentFix | null; lastMsg?: string
}
export type Incident = Omit<IncidentSummary, 'fix'> & {
  samples: { t: number; msg: string; detail?: string; ctx?: Record<string, unknown> }[]
  reporter?: { agent?: string; pane?: number } | null
  regressed?: number
  fix: (IncidentFix & { updates?: FixUpdate[]; started?: number; session?: string }) | null
}
export type FixerConfig = { fixer: 'auto' | 'bound' | 'new'; agent: 'auto' | 'claude' | 'codex' | 'cursor-agent'; bound: { session: string; agent: string; cwd: string; configDir?: string; label?: string } | null }

export const incidents = $state({ open: 0, list: [] as IncidentSummary[], config: null as FixerConfig | null, focus: '' as string })

export async function pollIncidents(full = false) {
  if (document.visibilityState !== 'visible') return
  try {
    const r = await fetch(`api/incidents${full ? '' : '?summary=1'}`, { cache: 'no-store' })
    if (!r.ok) return
    const d = await r.json()
    incidents.open = d.open || 0
    incidents.config = d.config || null
    if (full) incidents.list = d.incidents || []
  } catch {}
}
setInterval(() => pollIncidents(false), 30000)
document.addEventListener('visibilitychange', () => pollIncidents(false))
pollIncidents(false)

export async function getIncident(id: string): Promise<Incident> {
  const r = await fetch(`api/incidents/${id}`, { cache: 'no-store' })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || r.statusText)
  return d
}
export const incidentAction = (id: string, action: string, extra: Record<string, unknown> = {}) => postJson(`api/incidents/${id}/action`, { action, ...extra })
export const reportIncident = (title: string, detail: string, ctx: Record<string, unknown>) => postJson<IncidentSummary>('api/incidents/report', { title, detail, ctx })
export async function setFixer(patch: Partial<FixerConfig>) {
  incidents.config = await postJson<FixerConfig>('api/incidents/config', patch)
  return incidents.config
}
