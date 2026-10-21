# host/：pane-host

电脑上的常驻服务。用户文档（作用、安装、host-env、AI 提供方）见 [docs/host.md](../docs/host.md)（English: [docs/en/host.md](../docs/en/host.md)）。

```
server/server.mjs ──server/host-client.mjs──▶ agent/bridge host ──▶ host/connect.mjs ──unix socket──▶ host/main.mjs
                                                                                                    └─ hosts/macos（wezterm cli、agent/pane-transcript）
```

| 文件 | 作用 |
| --- | --- |
| `main.mjs` | 常驻进程：监听 `~/.cache/pane-remote-host/host.sock`（目录 0700、socket 0600），协议、主题、生命周期 |
| `connect.mjs` | 连接器：stdin/stdout ⇄ socket；pane-host 不在就就地拉起一个（detached，10 分钟没人连自己退出） |
| `protocol.mjs` | 按行 JSON 的 JSON-RPC 2.0 + call / stream / sub 扩展（说明在文件头），`Feed`（带序号、可补发的主题） |
| `delta.mjs` | 对话消息列表的增量 `{drop, keep, tail}`，服务端也用它 |
| `services/events.mjs` | `events` 主题：tail `~/.local/state/pane-remote/events.jsonl` |
| `services/transcript.mjs` | `transcript:<pane>:<条数>` 主题：fs.watch 会话记录，推增量 |
| `services/ai.mjs` | AI：把 `ai/`（本机 Claude Code / Codex / cursor-agent）挂到协议上 |
| `services/files.mjs` | 插件的只读文件访问（私有目录 + 用户加的目录，按真实路径核对） |
| `config.mjs` | 读 `~/.config/pane-remote/host-env`（代理等环境变量，交给 AI 子进程） |
| `ai/` | AI 提供方库，见 `ai/README.md` |
| `hosts/` | Host 接口（`interface.mjs`）和 macOS 实现；写别的平台见 `hosts/README.md` |
| `test/` | 集成测试（假 Host + 真 connect / HostClient / agent/pane-event）：`npm test` |

LaunchAgent 由 `lib/cli.mjs` 生成（`pane-remote init` 装、`uninstall` 卸）。

## 能力

| 方法 / 主题 | 说明 |
| --- | --- |
| `ping` | `{pong, t, version, pid, uptime, platform, home, feeds, caps}`（caps：`ai`、`fs`，Host 有 desktop 时加 `desktop`） |
| `terminals.list` | pane 列表，形状同 `/api/panes` |
| `terminals.text {pane, lines?, escapes?}` | 画面文字 |
| `terminals.watch {pane, lines?}`（stream） | 画面有变化就推 `{text}`，可 `cancel`（服务端暂未使用） |
| `transcript.get {pane, n?}` | 一次性取对话 `{session, messages}` |
| `ai.models {refresh?}` | `{models, skipped}`，模型字段见 `ai/README.md` |
| `ai.complete {req, advanced?}`（stream） | 片段 `{type: 'chunk', data: {role, content, reasoning_content?}}`；结束回 AiMessage（`advanced` 时回详细结果）。`cancel` 杀掉子进程 |
| `desktop.clipboard.readText` / `desktop.clipboard.writeText {text}` | 电脑剪贴板（pbpaste / pbcopy） |
| `desktop.openUrl {url}` | 在电脑上打开 http(s) 网址：直接 `/usr/bin/open`，不经过「网址转手机」模块的 open 包装 |
| `fs.roots {plugin, dirs}`、`fs.list / fs.stat / fs.read {plugin, root, path}` | 只读文件：`root` 是 `'private'`（`~/.local/share/pane-remote/plugins-data/<plugin>/`，用到时建，0700）或用户加的目录；真实路径必须落在根目录里，`.ssh`、`.gnupg`、钥匙串、`~/.config/pane-remote` 一律拒绝；单次最多读 10MB |
| 主题 `events` | 序号 = bridge `events` 的逻辑偏移（截断后也只增不减），data = 事件对象；带 `since` 重连从文件补发 |
| 主题 `transcript:<pane>:<n>` | data = `{full: [...]}` 或 `{drop, keep, tail}`；消息格式与 `/api/transcript` 完全相同；`since: 0` 先给 reset 全量；补发缓存最近 50 次 |

**流里的请求**（AI 的工具调用）：stream 处理函数可以 `ctx.request(x)`，pane-host 在流里发 `{id, chunk: {...x, rid}}`，
对端回通知 `{jsonrpc, method: 'reply', params: {id, rid, ok: true, value} | {id, rid, ok: false, error: {message, code}}}`；
服务端 `host.stream(...)` 返回的句柄有 `reply(rid, r)`。AI 的工具调用片段是 `{type: 'tool-call', rid, name, args}`。流被取消时还没回的请求一起作废。

relay 模式下电脑上的 bridge 还是旧版（不认 `host`）时，服务端 5 分钟重试一次，其间一切走 bridge 老路。
