# 进阶配置

中文 | [English](en/advanced.md)

## 持久化 pane：WezTerm 窗口关了也能用

默认情况下 pane 活在 WezTerm 窗口里，窗口一关里面的程序就结束了，手机也连不上。
让 WezTerm 把 pane 放在后台的 mux server 里，窗口只是一个「查看器」：关掉窗口程序照跑，手机照样能看能操作，再打开窗口会接回原来的 pane。

1. 在 `~/.wezterm.lua`（或 `~/.config/wezterm/wezterm.lua`）里加：

   ```lua
   config.unix_domains = { { name = 'unix' } }
   -- 打开 WezTerm 时自动连到后台的 mux server（没在跑就拉起来）
   config.default_gui_startup_args = { 'connect', 'unix' }
   ```

2. 完全退出 WezTerm 再打开。确认 `~/.local/share/wezterm/sock` 出现了
3. `pane-remote init` 重跑一次：检测到这个 socket 后会写进配置，之后 bridge 直接连 mux server
4. `pane-remote doctor` 确认「WezTerm 能连上」

想开机就有 mux server（不用先开一次窗口），可以加一个 launchd 常驻 `wezterm-mux-server --daemonize`，这一步可选。

注意：mux server 重启（比如升级 WezTerm）时，里面的 pane 会全部结束，和关掉终端一样。

自己写常驻脚本时务必用 `--daemonize` 启动 mux server：这样它会锁住 pid 文件。前台启动不锁，之后任何一次连不上的 `wezterm cli`（比如 socket 地址写错、又没加 `--no-auto-start`）都会拉起第二个空 server，把 `sock` 路径抢走；原来的 server 还活着，但谁也连不上它了，手机上只剩一个空的 zsh。

## 多个 Claude Code 账号

用 `CLAUDE_CONFIG_DIR` 把不同账号分开（`~/.claude-work`、`~/.claude-personal` 之类）时，init 会给每个配置目录都装上 hook，
并在 `claudeWrappers` 里记下「配置目录 → 启动命令」，分叉、恢复会话时用同一个账号启动，不然找不到原会话。默认生成的命令是：

```json
"claudeWrappers": {
  ".claude": "claude",
  ".claude-work": "CLAUDE_CONFIG_DIR=\"$HOME/.claude-work\" claude"
}
```

如果你平时用自己的包装命令启动（比如 `claude-work`），改成那个命令就行。新建 pane 的启动选项在 `presets` 里改。

## 只用来看、不允许操作

目前没有只读模式。别把不该能操作你电脑的人加进 `allowedLogins`。

## 自己跑服务、自己配反向代理

```bash
pane-remote init --skip-service --skip-serve
PANE_REMOTE_CONFIG=~/.config/pane-remote/config.json node server/server.mjs
```

反向代理必须像 tailscale serve 一样把访问者身份放进 `Tailscale-User-Login` 请求头，并且不能让访问者自己伪造这个头；
`serveHosts` 填代理对外的主机名。没有可靠身份来源时不要这样用。

## 不经 tailscale serve：睡一晚醒来连不上时

`tailscale serve` 在 tailscaled 自己的网络栈里收发连接。它已经忘掉的连接再收到包时，直接丢掉、不回 RST。
手机睡一晚醒来，还拿着睡前的连接发请求，这些包全被丢掉，请求一直挂着；重开 App 也复用同一批死连接，看起来就是整体断开、怎么都重连不上。
服务端日志（Linux 上 `journalctl -u tailscaled`）里会看到 `netstack: ... because the packet was not handled`。

可选的做法：让服务自己在 tailnet 地址上开 HTTPS，用系统内核的 TCP。死连接会立刻收到 RST，手机马上换新连接。
仍然只有 tailnet 能访问；身份改成按来源 IP 问本机 tailscaled（`whois`），客户端自己带的 `Tailscale-User-Login` 一律丢掉。

1. 生成证书（要在 Tailscale 后台开着 HTTPS）：

   ```sh
   sudo tailscale cert --cert-file ~/tls.crt --key-file ~/tls.key <本机>.<tailnet>.ts.net
   sudo chown "$USER" ~/tls.crt ~/tls.key
   ```

   证书 90 天过期，用 cron / launchd / systemd timer 每周重跑一次；服务每 6 小时重读证书，不用重启。
2. 关掉 serve 的 443：`sudo tailscale serve --https=443 off`
3. 在配置里加上（`tailscale ip -4` 查本机的 tailnet 地址）：

   ```json
   "tls": { "listen": "100.x.y.z:443", "cert": "~/tls.crt", "key": "~/tls.key" }
   ```

   也可以用环境变量 `TLS_LISTEN` / `TLS_CERT` / `TLS_KEY`。监听 443 要权限：Linux 上 systemd 加 `AmbientCapabilities=CAP_NET_BIND_SERVICE`，或者换个高端口（手机地址里带上端口）。
4. 重启服务。日志里出现 `pane-remote tls on 100.x.y.z:443` 就生效了。

改回去：删掉 `tls`，重新 `tailscale serve --bg --https=443 http://127.0.0.1:8787`，重启服务。
