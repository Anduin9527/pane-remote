// Codex 单独的 CODEX_HOME：不带 ~/.codex/AGENTS.md（用户写给编码 agent 的说明，几千 token，还可能规定回答语言），
// 会话、模型缓存也不混进用户自己的 ~/.codex。
// 登录共用：独立目录里的 auth.json 是指向 ~/.codex/auth.json 的软链。Codex 刷新令牌时如果顺着软链写，写的就是原文件；
// 如果是写临时文件再改名（软链被换成普通文件），调用结束后 reconcile() 把新令牌拷回原文件、恢复软链——
// 刷新令牌是一次性的，不拷回的话原来的登录会失效。
import fs from 'node:fs'
import path from 'node:path'

export function createCodexHome({ dir, home }) {
  const real = path.join(home, '.codex', 'auth.json')
  const link = path.join(dir, 'auth.json')
  function ensure() {
    fs.mkdirSync(dir, { recursive: true })
    let st = null
    try { st = fs.lstatSync(link) } catch {} // ignore: 第一次还没有
    if (st?.isSymbolicLink()) { if (fs.readlinkSync(link) === real) return; fs.unlinkSync(link) }
    else if (st) return reconcile() // 普通文件：上次没来得及同步
    fs.symlinkSync(real, link)
  }
  function reconcile() {
    let st
    try { st = fs.lstatSync(link) } catch { return }
    if (st.isSymbolicLink()) return
    // 独立目录里的是新令牌（比原文件新）就拷回去；原文件更新（用户自己在别处刷新过）就丢掉这份
    let realM = 0
    try { realM = fs.statSync(real).mtimeMs } catch {} // ignore: 原文件不在（用户登出了）
    if (st.mtimeMs > realM) {
      const tmp = `${real}.pane-remote-${process.pid}`
      fs.copyFileSync(link, tmp)
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, real)
    }
    fs.unlinkSync(link)
    fs.symlinkSync(real, link)
  }
  return {
    dir,
    env(base) { ensure(); return { ...base, CODEX_HOME: dir } },
    reconcile() { try { reconcile() } catch (e) { console.error(`codex-home: ${e.message}`) } },
  }
}
