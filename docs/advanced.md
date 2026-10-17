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

## 多个 Claude Code 账号

用 `CLAUDE_CONFIG_DIR` 把不同账号分开（`~/.claude-work`、`~/.claude-personal` 之类）时，init 会给每个配置目录都装上 hook，
并在 `claudeWrappers` 里记下「配置目录 → 启动命令」，分叉会话时用同一个账号启动，不然找不到原会话。默认生成的命令是：

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
