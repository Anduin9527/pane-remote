// 配置：默认读 ~/.config/pane-remote/config.json（`pane-remote init` 生成），环境变量 PANE_REMOTE_CONFIG 可以指定别的文件。
// 没写的项用下面的默认值。
//
// mode
//   local  服务跑在这台电脑上，由本机的 `tailscale serve` 对 tailnet 提供 HTTPS（基础版）
//   relay  服务跑在一台中转服务器上，经 SSH 反向隧道调用电脑上的 bridge（增强版：电脑不方便直接装 Tailscale 时）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = process.env.PANE_REMOTE_CONFIG || path.join(os.homedir(), '.config/pane-remote/config.json')

const DEFAULTS = {
  mode: 'local',
  port: 8787,
  // 允许访问的 Tailscale 登录名（tailscale serve 注入的 Tailscale-User-Login）。空 = 谁都不让进
  allowedLogins: [],
  // local 模式额外校验 Host：只认 tailscale serve 转发过来的这些主机名（init 时写入本机的 xxx.ts.net 名字）
  serveHosts: [],
  dataDir: path.join(os.homedir(), '.local/share/pane-remote'),
  scrollbackLines: 300,
  modules: {
    preview: true, // 预览浏览器（要 Chrome）
    openUrl: false, // 电脑上打开网址时，人在用手机就转到手机预览（会接管 open 命令）
    cursor: false, // Cursor IDE 映射：会话 / 消息 / 改动 / 内置浏览器（Cursor 要带调试端口启动，必要时会重启 Cursor）
  },
  // 新建 pane 时可选的启动命令
  presets: [
    { label: 'Claude Code', command: 'claude' },
    { label: 'Codex', command: 'codex' },
  ],
  // Claude 配置目录名 → 启动命令。分叉会话时必须用会话所在账号的命令，不然找不到会话
  claudeWrappers: { '.claude': 'claude' },
  vapidSubject: 'mailto:pane-remote@localhost',
  // relay 模式：中转服务器怎么连回电脑（经反向隧道）
  relay: {
    target: '', // 电脑上的用户名@127.0.0.1
    port: 2222, // 反向隧道在中转服务器上监听的端口
    identity: path.join(os.homedir(), '.ssh/pane_bridge'),
  },
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] ? merge(base[k], v) : v
  }
  return out
}

let fileConfig = {}
try { fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch (e) {
  if (e.code !== 'ENOENT') throw new Error(`配置文件 ${CONFIG_PATH} 读不了：${e.message}`)
}
export const config = merge(DEFAULTS, fileConfig)
const expand = (p) => String(p || '').replace(/^~(?=\/|$)/, os.homedir())
config.dataDir = expand(config.dataDir)
config.relay.identity = expand(config.relay.identity)
// 环境变量覆盖（方便测试）
if (process.env.PORT) config.port = Number(process.env.PORT)
if (process.env.ALLOWED_LOGINS) config.allowedLogins = process.env.ALLOWED_LOGINS.split(',').map((s) => s.trim()).filter(Boolean)
if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR
