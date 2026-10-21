// pane-host 的环境配置文件：launchd 起的进程没有 shell 里的变量（HTTPS_PROXY 之类），Claude Code / Codex 出网要靠它们。
// 文件 ~/.config/pane-remote/host-env（PANE_HOST_ENV_FILE 可改，测试用），每行 KEY=VALUE，# 开头是注释，值两边的引号去掉，开头的 ~ 换成家目录。
// 不存在就当空的；权限比 0600 宽时照样读，但日志里提醒一句（里面可能有带密码的代理地址）。值一律不打印。
import fs from 'node:fs'
import path from 'node:path'
import { HOME } from './paths.mjs'

export const HOST_ENV_FILE = process.env.PANE_HOST_ENV_FILE || path.join(HOME, '.config/pane-remote/host-env')

/** → { env: {KEY: VALUE}, keys: [KEY…], warn?: string } */
export function readHostEnv(file = HOST_ENV_FILE) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return { env: {}, keys: [] } }
  const env = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').replace(/^~(?=\/|$)/, HOME) // 开头的 ~ 换成家目录（launchd 不会展开）
  }
  let warn
  try { if (fs.statSync(file).mode & 0o077) warn = `${file} 权限太宽，建议 chmod 600` } catch {} // ignore: 刚读过，stat 失败也不影响
  return { env, keys: Object.keys(env), warn }
}
