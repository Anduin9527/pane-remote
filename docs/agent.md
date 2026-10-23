# Agent 工具（pane-remote 插件）

中文 | [English](en/agent.md)

从手机上开的 agent 可以加载一个 pane-remote 插件。加载后 agent 知道自己跑在手机遥控环境里，还能反过来用手机和这台电脑：做完了推送给你、卡住了在手机上问你、把开发服务器直接开到你手机的预览里。

支持 Claude Code CLI、Codex、cursor-agent。不用单独开启，`pane-remote init` 会把它准备好。

## 怎么加载

- **新建 pane / 分叉会话**：启动选项下面有「注入 pane-remote 工具」，默认勾上，记在手机上。只对认得的 agent 命令生效（`claude`、`claude-*`、`codex`、`cursor-agent`，以及 `claudeWrappers` 里的命令），别的命令原样执行。
- **已经开着的会话**：「会话」面板里点「重启并注入」（点两次确认）。同一个会话原地重启，上下文不丢，见下面的[重启并注入](#重启并注入)。

各家加载插件的方式不同，统一由 `agent/plugin/bin/with-tools` 处理：

| agent | 怎么加载 |
|---|---|
| Claude Code | `--plugin-dir agent/plugin`（MCP 服务 + skill） |
| cursor-agent | `--plugin-dir agent/plugin --approve-mcps` |
| Codex | 没有插件目录参数：用 `-c mcp_servers.pane-remote.*` 配 MCP，`developer_instructions` 让它在开始时读 skill |

服务端在 pane 里敲的是 `~/.local/share/pane-remote/with-tools <原来的命令>`。这个链接由 `init` / `refresh bridge-env` 建（中转模式下服务端不知道仓库在电脑上哪）。

## 给 agent 的工具（MCP）

| 工具 | 做什么 |
|---|---|
| `user_whereabouts` | 你大概在哪：手机 2.5 分钟内用过没有、电脑键鼠空闲了多久 |
| `notify_phone` | 推一条通知（同一个 pane 20 秒一条、全部每小时 20 条） |
| `ask_phone` | 在手机上问你一个问题：推送 + 顶部弹出卡片，点选项或者直接写一句回答；agent 一直等到你回答或超时（默认 10 分钟，最长 30 分钟） |
| `open_on_phone` | 在手机的预览里打开一个网址（预览的浏览器在电脑上跑，所以 `localhost` 也能开） |
| `mac_perf` / `mac_say` | 电脑的 CPU、内存、占用最多的进程；用 `say` 念一段话 |
| `mac_lock` | 锁屏（**要你在手机上确认**） |
| `list_panes` / `read_pane` | 看有哪些 pane、读别的 pane 最近的内容 |
| `send_to_pane` | 往别的 pane 里打字（**要你在手机上确认**，不能发给自己） |
| `report_incident` | 报告 pane-remote 自己的问题（结果不对、通知没到……），见 [问题报告](incidents.md) |
| `incident_get` / `incident_update` | 修复问题的 agent 用：读简报、报进度 |

skill（`agent/plugin/skills/pane-remote/SKILL.md`）告诉 agent 什么时候用这些：人不在电脑前又卡在决定上就用 `ask_phone`，别拿通知报流水账，回复照顾手机小屏，确认被拒绝了不许绕过。

手机上的提问在「待办」里也能看到、直接回答。没答的问题在推送里点开就是那个 pane。

插件工具（名字是 `plugin_<插件 id>_<工具名>`，比如待办的 `plugin_todo_*`）也在这里，见 [插件平台](plugins.md)「插件工具」。插件给会话的留言（比如你在手机上勾掉了它记的待办）由插件里的 `hooks/hooks.json`（Claude Code 的 UserPromptSubmit hook）在你下一次发消息时带给 agent，其他 agent 在下一次调 pane-remote 工具时附在结果后面，都不打断它。

**说明**：「要你在手机上确认」是防 agent 手滑，不是安全边界——agent 本来就能执行 shell 命令。

## 重启并注入

给已经开着、没加载插件的会话补上插件。只在 agent 空闲时才能点（Claude Code 看它自己记的状态；Codex、cursor-agent 看画面），正在干活、在等你确认时都不行。

流程（都在电脑上跑，手机断了也会做完，进度在面板里显示）：

1. **存快照**（`~/.local/state/pane-remote/agent/snapshots/`，保留最近 30 份）。Claude Code 会记下这次启动后开的、还没结束的后台命令、异步子代理、Monitor，还有定时任务和没做完的 task；Codex、cursor-agent 只记会话本身。
2. **让 agent 自己退出**：Claude Code 用 `/exit`。有后台任务时它会问怎么处理，选「退出并停掉」（快照已经存了），绝不选「转到后台」（那样会话还在后台进程里，再恢复就是两个进程写同一个会话）。Codex、cursor-agent 按 Ctrl-C。等进程按 PID 真的没了才继续；20 秒还在就停下报错，不杀进程。
3. **原地重开**：在会话原来的目录，用原来的启动参数（模型、权限模式等）加上恢复会话的参数和插件。带插件起不来就退回不带插件的普通恢复。Codex 的对话被另一个 Codex 应用占着时，按它的提示分叉一个新会话（上下文都在），面板里会提示。
4. **发恢复说明**（只有快照里有东西时）：给 agent 发一句 `[pane-remote restore]`，让它读快照：只读的（定时任务、Monitor、看日志 / 监视 / 开发服务器这类后台命令）自己重建；会改东西的命令和子代理逐条列出来先问你；task 列表跟着会话保留，只核对。

输入框里没发出去的字会被清掉。

## 结构

```
agent（Claude Code / Codex / cursor-agent）
   │ stdio MCP
   ▼
agent/plugin/mcp.mjs（启动器）→ mcp-server.mjs（电脑上，零依赖）
   │ 插件工具（plugin_<id>_<工具>）：经 pane-host 的 socket 转给服务端（见 plugins.md「插件工具」）
   │ 往手机：写一条 kind=agent 的事件到 ~/.local/state/pane-remote/events.jsonl（和 hook 同一个文件）
   │ 本机操作：调 agent/bridge（list / text / send / mac-perf / mac-say）
   ▼
pane-remote 服务（server/server.mjs：onAgent 推送、把问题挂到 /api/states 对应 pane 上）
   │ 手机回答：POST /api/agent/answer → bridge agent-answer → answers/<id>.json → MCP 轮询到
   ▼
手机（web/src/lib/components/AgentAsk.svelte、Inbox、会话面板）
```

更新：`mcp.mjs` 只是启动器，真正的服务 `mcp-server.mjs` 跑在子进程里；文件一换（更新 pane-remote 之后）就起一个新的子进程，重放 `initialize` 接上，旧的回完手上的请求退出，再告诉 agent 工具列表变了。正在跑的 agent 不用重连。新代码起不来就继续用旧的。

重启并注入：`POST /api/agent/restart {pane, confirm: true}` → bridge `agent restart` → `agent/pane-agent`（脱离 bridge 在后台跑，进度写到 `~/.local/state/pane-remote/agent/restart/<pane>.json`）。

## 模型和思考等级

会话栏里的模型芯片（形如「Opus · High」）显示这个 pane 里 agent 当前用的模型和思考等级，点开是单列面板：上面选模型，下面一排分段按钮选思考等级，点「切换」。

- Claude Code、Codex、cursor-agent 都支持；开了 Cursor 模块时，Cursor IDE 的会话也有同样的芯片。
- 只在 agent 空闲、输入框空着时切换（正在干活回 409，输入框里有字也会拒绝，免得把你打了一半的话发出去）。
- 实现方式是在 pane 里操作 agent 自己的模型选择器（`agent/pane-agent` 的 `MODEL_UI` 表，agent 升级后画面变了只改这里）：
  - Claude Code、Codex：只改这个会话（选择器里的「只改这个会话」），不动新会话的默认值。
  - cursor-agent：它没有「只改这个会话」，选定就写进它自己的配置（它的设计），面板里会提示「会改默认」。
  - Cursor IDE：操作输入框下方的选择器，再从 Cursor 的本地数据库读回确认；Cursor 会同时把它记成新会话的默认模型。
- 第一次读 Claude 的模型列表要把选择器翻一遍（十几秒），之后读缓存；面板右上角可以重新读取。
- 接口：`GET /api/agent/model?pane=N[&refresh]`（或 `?cursor=<会话>`）、`POST /api/agent/model {pane | cursor, model, effort?}`；失败时带 `tail`（画面末尾）方便看卡在哪。

## 排查

- 「会话」面板没有「pane-remote 工具」这一栏：这个 pane 前台不是认得的 agent。
- 注入后工具不见：看 `~/.local/state/pane-remote/agent/mcp.log`（每次 MCP 启动一行：哪个 agent、认到的 pane）。`pane=null` 说明没认出在哪个 pane，手机收不到它的提问。
- `pane-remote doctor` 里「agent 工具没链接好」：跑 `pane-remote refresh bridge-env`。
- 重启停在「退出」：去 pane 里看看 agent 是不是弹了别的确认框；快照已经存了。
