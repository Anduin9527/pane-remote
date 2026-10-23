// 权限：直接用 whatevertools core 的 PermissionManager（Chrome 式：默认询问；仅本次 / 始终允许 / 禁止 / 以后再说；
// 连续关掉 3 次转为禁止；按插件存）。这里只补平台需要的三样：
//   - 存储：数据目录下的 permissions.json（HostStore 的文件实现）
//   - 问询：谁发起的调用就问谁（AsyncLocalStorage 带着调用上下文，ctx.prompt 弹到发起调用的那台手机上）
//   - pane-remote 专属的权限项（platform.*）
// 「仅本次」的有效期是插件这次打开：插件关掉（或睡眠后重开）就清掉，但连续关掉的次数保留。
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { HookRegistry, MemoryHostStore, PermissionManager, PERMISSIONS, PERMISSION_MAP } from '@whatevertools/core'

// 平台专属权限：登记进 core 的权限表（同一进程里的模块单例），问询文案、snapshot 才认得
export const PLATFORM_PERMISSIONS = [
  { id: 'platform.incident', title: '问题报告', description: '把插件发现的问题记进 pane-remote 的问题报告', default: 'grant', risk: 'low' },
  { id: 'platform.storage', title: '共享存储', description: '读写和其他插件共用的存储组', default: 'ask', scoped: true, risk: 'medium' },
  { id: 'platform.agent', title: '向你提问 / 推送', description: '像 agent 的 ask_phone / notify_phone 一样在手机上问你、给你推送', default: 'ask', risk: 'medium' },
]
for (const p of PLATFORM_PERMISSIONS) if (!PERMISSION_MAP[p.id]) { PERMISSIONS.push(p); PERMISSION_MAP[p.id] = p }

class FileHostStore extends MemoryHostStore {
  constructor(file) {
    super()
    this.file = file
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.data.set(k, v) } catch {}
  }
  changed() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(Object.fromEntries(this.data)), { mode: 0o600 })
      fs.renameSync(this.file + '.tmp', this.file)
    } catch (e) { console.error(`plugins: save permissions ${e.message}`, e) }
  }
}

export function createPermissions({ file, dismissLimit = 3 }) {
  const als = new AsyncLocalStorage()
  const store = file ? new FileHostStore(file) : new MemoryHostStore()
  const pm = new PermissionManager({
    store,
    hooks: new HookRegistry(),
    policy: { mode: 'enforce', dismissLimit },
    prompter: {
      // 没有能问的人（比如调用方连接已经断了）：按「以后再说」处理
      prompt: async (req) => {
        const ctx = als.getStore()
        if (!ctx?.prompt) return 'dismiss'
        const a = await ctx.prompt(req)
        return ['once', 'always', 'block', 'dismiss'].includes(a) ? a : 'dismiss'
      },
    },
  })

  /** 确保插件已登记（描述文件里的 permissions 只影响问询文案，不会自动授予） */
  function ensure(m) {
    try { return pm.get(m.id) } catch { return pm.register(m.id, m.name, m.permissions || {}) }
  }

  return {
    pm,
    ensure,
    /** 检查，需要时经 ctx.prompt 问；拒绝时抛 EWTPERM */
    permit: (ctx, m, permission, scope) => { ensure(m); return als.run(ctx, () => pm.permit(m.id, permission, scope)) },
    check: (m, permission, scope) => { ensure(m); return pm.check(m.id, permission, scope) },
    /** 插件这次打开结束：清掉「仅本次」，保留连续关掉的次数 */
    endSession(m) {
      let old
      try { old = pm.get(m.id) } catch { return }
      const set = pm.register(m.id, m.name, m.permissions || {})
      // dismissed 是 PermissionSet 的私有字段（TS 层面），JS 里可以带过去；core 没有「只清本次」的接口
      if (old.dismissed) set.dismissed = { ...old.dismissed }
    },
    /** 设置页：列出这个插件每项权限的结论（只列声明过的、记住过的和默认不是授予的平台权限） */
    list(m) {
      const set = ensure(m)
      const remembered = set.rememberedGrants()
      const ids = new Set([...Object.keys(m.permissions || {}), ...Object.keys(remembered)])
      return [...ids].map((id) => ({ id, title: PERMISSION_MAP[id]?.title || id, description: PERMISSION_MAP[id]?.description || '', reason: m.permissions?.[id]?.reason || '', decision: set.resolve(id).decision, remembered: !!remembered[id] }))
    },
    /** 用户明确选过「禁止」（记住了的，或连续关掉 3 次自动转的）——和「这次打开里没答应」区分开 */
    blocked(m, permission) { const set = ensure(m); return set.rememberedGrants()[permission] !== undefined && set.resolve(permission).decision === 'deny' },
    set: (m, permission, decision) => { ensure(m); pm.set(m.id, permission, decision) },
    reset: (m) => { ensure(m); pm.reset(m.id) },
  }
}
