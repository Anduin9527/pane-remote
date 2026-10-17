// 增强版：中转模式的辅助命令（完整步骤见 docs/relay.md）
//
// 什么时候用：电脑本身跑不了 Tailscale，但有一台在你 tailnet 里、你一个人专用的服务器。
// 结构：手机 → 服务器上的 tailscale serve → 服务器上的 pane-remote 服务 → SSH 反向隧道 → 电脑上的 agent/bridge
//
//   pane-remote relay authorized-key <公钥文件>     打印电脑 ~/.ssh/authorized_keys 里要加的那一行（只能执行 bridge）
//   pane-remote relay tunnel <用户@服务器> [--ssh-port 22] [--remote-port 2222] [--key 私钥]
//                                                 在电脑上装一个常驻的反向隧道（launchd），断了自动重连
//   pane-remote relay tunnel-off                   去掉反向隧道
//   pane-remote relay server-config --mac-user <电脑用户名> --login <Tailscale 登录名>
//                                                 打印服务器上 ~/.config/pane-remote/config.json 的内容
//   pane-remote relay systemd                      打印服务器上的 systemd 服务文件
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const LABEL = 'local.pane-remote.tunnel'
const PLIST = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
const args = process.argv.slice(2)
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d)
const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

switch (args[0]) {
  case 'authorized-key': {
    const f = args[1] || die('给公钥文件路径，比如 ~/.ssh/pane_remote_bridge.pub')
    const key = fs.readFileSync(f.replace(/^~/, HOME), 'utf8').trim()
    if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+/.test(key)) die('不像是 SSH 公钥')
    // restrict：禁掉端口转发、终端等一切额外能力；command：不管对方想执行什么，都只跑 bridge（bridge 自己只认白名单指令）；
    // from：只接受经反向隧道进来的连接（在电脑上看来来自本机）
    const bridge = path.join(APP_DIR, 'agent/bridge')
    // command="…" 里的内容会交给 shell：路径单引号包起来；双引号和换行会破坏 authorized_keys 的格式，直接拒绝
    if (/["\n\r]/.test(bridge)) die(`安装路径里有双引号或换行，没法安全地写进 authorized_keys：${bridge}`)
    const quoted = `'${bridge.replace(/'/g, `'\\''`)}'`
    console.log(`restrict,from="127.0.0.1,::1",command="${quoted}" ${key.split(/\s+/).slice(0, 2).join(' ')} pane-remote-bridge`)
    break
  }
  case 'tunnel': {
    const target = args[1]
    if (!/^[\w.-]+@[\w.-]+$/.test(target || '')) die('用法：pane-remote relay tunnel <用户@服务器>')
    const sshPort = String(Number(opt('--ssh-port', 22)))
    const remotePort = String(Number(opt('--remote-port', 2222)))
    const key = opt('--key', path.join(HOME, '.ssh/pane_remote_tunnel')).replace(/^~/, HOME)
    if (!fs.existsSync(key)) die(`没有隧道私钥 ${key}：先 ssh-keygen -t ed25519 -f ${key} -N ""，再把 .pub 加到服务器的 authorized_keys`)
    const argv = ['/usr/bin/ssh', '-N', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${HOME}/.ssh/known_hosts`,
      '-i', key, '-p', sshPort, '-R', `127.0.0.1:${remotePort}:127.0.0.1:22`, target]
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${argv.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardErrorPath</key><string>${esc(path.join(HOME, 'Library/Logs/pane-remote-tunnel.log'))}</string>
</dict>
</plist>
`
    fs.mkdirSync(path.dirname(PLIST), { recursive: true })
    fs.writeFileSync(PLIST, plist, { mode: 0o644 })
    const uid = process.getuid()
    spawnSync('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`])
    const r = spawnSync('/bin/launchctl', ['bootstrap', `gui/${uid}`, PLIST], { encoding: 'utf8' })
    if (r.status !== 0) die(`加载隧道失败：${r.stderr}`)
    console.log(`✓ 反向隧道已装：服务器的 127.0.0.1:${remotePort} → 这台电脑的 sshd（日志 ~/Library/Logs/pane-remote-tunnel.log）`)
    console.log('  电脑要打开「系统设置 → 通用 → 共享 → 远程登录」，sshd 才会监听')
    break
  }
  case 'tunnel-off': {
    spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`])
    try { fs.unlinkSync(PLIST) } catch {}
    console.log('✓ 反向隧道已去掉')
    break
  }
  case 'server-config': {
    const macUser = opt('--mac-user') || die('要 --mac-user（电脑上的用户名）')
    const login = opt('--login') || die('要 --login（允许访问的 Tailscale 登录名）')
    if (!/^[\w.-]+$/.test(macUser)) die('用户名不对')
    console.log(JSON.stringify({
      mode: 'relay',
      port: 8787,
      allowedLogins: [login],
      relay: { target: `${macUser}@127.0.0.1`, port: Number(opt('--remote-port', 2222)), identity: '~/.ssh/pane_remote_bridge' },
    }, null, 2))
    break
  }
  case 'systemd': {
    console.log(`[Unit]
Description=pane-remote relay
After=network-online.target

[Service]
User=<服务器用户名>
WorkingDirectory=/home/<服务器用户名>/pane-remote
Environment=PANE_REMOTE_CONFIG=/home/<服务器用户名>/.config/pane-remote/config.json
ExecStart=/usr/bin/node server/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/home/<服务器用户名>/.local/share/pane-remote /home/<服务器用户名>/.ssh

[Install]
WantedBy=multi-user.target`)
    break
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    console.log('完整步骤：docs/relay.md')
}
