# Host 实现

pane-host 里和平台绑定的部分都收在 Host 对象里（类型见 `interface.mjs`），服务（`../services/`）只调它。
现在只有 `macos/`。写别的平台（比如 Linux + tmux / WezTerm）：

1. 新建 `hosts/linux/index.mjs`，`export function createHost()` 返回符合 `interface.mjs` 的对象：
   - `terminals.list()`：返回 `Terminal[]`（字段和服务端 `/api/panes` 一样，手机端直接用）。tmux 可以用
     `tmux list-panes -a -F '#{pane_id} #{window_id} #{session_name} #{pane_current_path} #{pane_width} #{pane_height} …'`，
     `pane` 要是数字（tmux 的 `%12` 去掉 `%`）。
   - `terminals.text(pane, {lines, escapes})`：tmux 是 `capture-pane -p -t %N -S -<lines>`，`escapes` 对应 `-e`。
   - `agents.session(pane)`：找 pane 前台进程里的 Claude / Codex 会话（`agent/pane-transcript` 的 `session` 逻辑大部分是平台无关的 Python，
     只有 `fg_procs` 用了 wezterm cli 和 macOS 的 ps 参数；可以把它改成可替换的，或者在 JS 里重写）。
   - `agents.messages(session, n)`：`pane-transcript messages-file <agent> <记录文件> <n>` 本身不依赖平台，可以直接用。
   - `agents.watchFiles(session)`：要 fs.watch 的文件（Linux 上 fs.watch 走 inotify，一样能用）。
   - `events.log`：hook 写的事件日志路径（`agent/pane-event` 也不依赖平台）。
2. 启动时用 `PANE_HOST_IMPL=<路径>/hosts/linux/index.mjs node host/main.mjs` 选实现（或者在 `main.mjs` 里按 `process.platform` 选）。
3. socket 路径、协议、主题都不用改；Linux 上用 systemd user unit 代替 LaunchAgent（macOS 的由 `lib/cli.mjs` 生成）。
4. 用 `test/fake-host.mjs` 当最小样例；集成测试换成你的实现也应该能过（假 Host 只是让测试不依赖终端）。

`desktop`（剪贴板读写、在本机打开网址）可选：没有时插件的「用 Mac 的剪贴板 / 在 Mac 上打开」报错，其他照常。Linux 可以用 `wl-paste`/`xclip` 和 `xdg-open`。

没实现的能力（`ide`、`secrets`）留空即可，调用方会先看有没有。
