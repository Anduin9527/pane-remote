# pane-host（电脑上的常驻服务）

中文 | [English](en/host.md)

pane-host 是跑在电脑上的一个常驻 Node 进程（`host/main.mjs`）。服务端经 bridge 的 `host` 指令和它保持**一条**长连接（local 模式是本机子进程，relay 模式是一条 ssh），说按行 JSON 的 JSON-RPC：

```
手机 ──SSE / WS──▶ server/server.mjs ──server/host-client.mjs──▶ agent/bridge host ──▶ host/connect.mjs ──unix socket──▶ host/main.mjs
```

它带来的：

- **对话视图改成推送**：pane-host 盯着会话记录文件，有变化才推增量（`/api/transcript/stream`），不再每隔几秒拉一次；hook 事件也由它推，不再轮询 `bridge events`。
- **插件平台的电脑端能力**：AI（本机已登录的 Claude Code / Codex / cursor-agent）、电脑剪贴板、在电脑上打开网址、只读文件，见 [plugins.md](plugins.md)。
- relay 模式下少拉起很多 ssh / bash / python 进程。

**pane-host 不在线时一切照常**：对话和事件自动回到 bridge 老路（轮询），只有插件的电脑端能力暂时用不了（回 `EWTHOSTDOWN`）。

## 安装和管理

`pane-remote init` 会把它装成 LaunchAgent（`local.pane-remote.host`，开机自动启动，异常退出自动重启）：

```bash
pane-remote init                 # 装 / 更新 LaunchAgent（--skip-host 不装）
pane-remote doctor               # 「pane-host 在运行」那一项
pane-remote restart              # 连同 pane-host 一起重启
pane-remote uninstall            # 停掉并移除
```

不装 LaunchAgent 也能用：第一次有连接时 `host/connect.mjs` 会就地拉起一个，10 分钟没人连自己退出。

| 文件 | 说明 |
|---|---|
| `~/.cache/pane-remote-host/host.sock` | unix socket（目录 0700、socket 0600，只有你自己能连） |
| `~/.cache/pane-remote-host/host.log` | 日志，只在启动、退出时写几行 |
| `~/.config/pane-remote/host-env` | 可选：给 pane-host 的环境变量（见下） |

关掉：配置里写 `"paneHost": false`（服务端不再连它），或者服务端环境变量 `PANE_HOST=0`。

## 代理、Claude 配置目录（host-env）

LaunchAgent 起的进程没有你 shell 里的环境变量。AI 要走代理、或者 Claude Code 用的是别的配置目录时，写 `~/.config/pane-remote/host-env`（每行 `KEY=VALUE`，`#` 是注释），改完 `pane-remote restart`：

```sh
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
CLAUDE_CONFIG_DIR=~/.claude-work
```

文件建议 `chmod 600`（权限太宽时日志里会提醒）；日志只记变量名，不记值。

## AI 提供方

AI 用的是电脑上**已经登录**的命令行 agent，pane-remote 不保存任何 API key：

| 提供方 | 要什么 | 模型列表从哪来 |
|---|---|---|
| Claude Code | `claude` 能用且已登录（`claude auth status`） | 内置几个常用模型 |
| Codex | `codex` 已登录（`codex login status`） | Codex 自己的模型缓存 |
| cursor-agent | `cursor-agent` 已登录（`cursor-agent status`） | `cursor-agent --list-models` |

哪个都没有，插件里的模型列表就是空的。每次调用都要插件先拿到 `ai` 权限（在手机上问你），消耗的是对应账号的额度。AI 子进程在家目录外面的临时目录里跑（免得带上你的全局 CLAUDE.md），不读写你的项目。

## 协议和开发

- 协议：`host/protocol.mjs`（文件头有说明）：JSON-RPC 2.0 加 call / stream / sub 三种扩展，主题带序号，断线重连能补发。
- 方法：`ping`、`terminals.list` / `terminals.text` / `terminals.watch`、`transcript.get`、`ai.models` / `ai.complete`、`desktop.clipboard.*` / `desktop.openUrl`、`fs.*`、`plugins.tools.list` / `plugins.tools.call` / `plugins.tools.changed`、`relay.serve`（服务端开的反向通道，插件工具经它转给服务端）；主题 `events`、`transcript:<pane>:<条数>`、`plugins.tools`。
- 平台相关的部分都在 Host 接口里（`host/hosts/interface.mjs`），现在只有 macOS 实现；写别的平台见 `host/hosts/README.md`。
- AI 库的细节见 `host/ai/README.md`。
- 测试：`npm test`（假 Host + 真 connect / host-client / agent/pane-event，不碰真的终端和 agent）。
- 手动自检：`SSH_ORIGINAL_COMMAND=host agent/bridge`，输入 `{"jsonrpc":"2.0","id":1,"method":"ping"}` 回车，应该马上回一行。
