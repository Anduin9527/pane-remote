// Claude Code 自带的任务列表（TaskCreate / TaskUpdate 写的）：<配置目录>/tasks/<会话 id>/<编号>.json，
// 每个文件 { id, subject, description, activeForm, status: pending | in_progress | completed, blocks, blockedBy }。
// 只读：Claude Code 运行中会覆盖自己的文件，这里不写。配置目录要在家目录下（多个账号各有一个，比如 ~/.claude-xxx）。
//   agents.tasks {items: [{session, configDir}]} → { <session>: { tasks: [...], mtime } }
import fs from 'node:fs/promises'
import path from 'node:path'
import { HOME } from '../paths.mjs'

const err = (msg) => Object.assign(new Error(msg), { code: 'EBADARG' })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

async function readSession(session, configDir) {
  const conf = await fs.realpath(configDir).catch(() => null)
  if (!conf || !conf.startsWith(HOME + path.sep) || !path.basename(conf).startsWith('.claude')) throw err('配置目录不对')
  const dir = path.join(conf, 'tasks', session)
  let names
  try { names = (await fs.readdir(dir)).filter((n) => /^\d{1,6}\.json$/.test(n)) } catch { return { tasks: [], mtime: 0 } }
  let mtime = 0
  const tasks = []
  for (const n of names.slice(0, 500)) {
    try {
      const f = path.join(dir, n)
      const st = await fs.stat(f)
      if (st.size > 64 << 10) continue
      mtime = Math.max(mtime, st.mtimeMs)
      const t = JSON.parse(await fs.readFile(f, 'utf8'))
      tasks.push({
        id: str(String(t.id ?? n.replace('.json', '')), 12),
        subject: str(t.subject, 300),
        description: str(t.description, 2000),
        activeForm: str(t.activeForm, 200),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        blocks: Array.isArray(t.blocks) ? t.blocks.map(String).slice(0, 20) : [],
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String).slice(0, 20) : [],
      })
    } catch {} // ignore: 正在写的半个文件，下次再读
  }
  tasks.sort((a, b) => Number(a.id) - Number(b.id))
  return { tasks, mtime }
}

export function createAgentTasksService() {
  return {
    calls: {
      'agents.tasks': async ({ items } = {}) => {
        const out = {}
        for (const it of (Array.isArray(items) ? items : []).slice(0, 30)) {
          const session = String(it?.session || '')
          if (!UUID.test(session) || typeof it?.configDir !== 'string') continue
          try { out[session] = await readSession(session, it.configDir) } catch (e) { out[session] = { tasks: [], mtime: 0, error: e.message } }
        }
        return out
      },
    },
  }
}
