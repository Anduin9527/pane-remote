# 问题报告（incidents）

中文 | [English](en/incidents.md)

pane-remote 把各处发现的异常收到一处，同一个问题只记一条、累计次数。必要时推送到手机，问你要不要修；你点「修复」，就交给一个 agent 在 pane-remote 仓库里修，修完再回报给你。

问题存在跑服务的那台机器上（`<dataDir>/incidents.json`，最多 300 条），不上传到任何地方。

## 谁会发现问题

pane-remote 本身没有模型能力。程序判断不了「结果对不对」这种需要理解的事，所以按能力分几层：

| 来源 | 发现什么 |
|---|---|
| 服务端 | 进程级异常；接口里的程序错误（`TypeError`、JSON 解析失败、Python traceback 之类，参数不对这种正常拒绝不算）；推送发不出去；扫描循环出错（电脑睡着连不上不算）；同一个 pane 5 分钟重连超过 8 次；到电脑的连接恢复不了 |
| 手机端 | 脚本错误、未处理的 Promise、页面 6 秒没渲染出来、发送失败（网络抖动常见，只按次数提醒） |
| 电脑端 | MCP 工具意外出错（「没有这个 pane」这种正常拒绝不算）；「重启并注入」失败 |
| agent | 注入了插件的 agent 用 `report_incident` 报：调用「成功」了但结果不对、通知没到手机、你说 pane-remote 哪里不对劲。这是程序自己判断不了的部分 |
| 你 | 手机上「问题报告 → 报告一个问题」，自动带上当前 pane 和手机信息 |

去重靠「指纹」：来源 + 模块 + 类型 + 规整过的消息（去掉数字、ID、构建文件名、家目录）。修好的问题又出现，会重新打开，并按严重处理。

## 什么时候推送

- 严重的（进程崩溃、程序错误、页面卡住、修好后又出现）第一次出现就推；
- 其余的在第 3 / 10 / 50 / 200 次时推；
- 同一个问题 30 分钟内最多推一条，所有问题加起来每小时最多 8 条；
- 已忽略、设了「这类不再提醒」、正在修的不推。你自己报告的也不推。

推送点开就是那条问题的详情。iPhone 主屏幕网页的推送没有按钮，修复 / 忽略在详情页里选。

## 手机上

- 有待处理的问题时，顶栏会出现红色的数字；「⋯」菜单里也有「问题报告」。
- 详情页显示最近 5 次的原文和上下文，以及修复的进度时间线。
- 可以做的操作：修复、新开 agent 修、忽略、这类不再提醒、已解决、重新打开、取消修复。

## 交给谁修

在「问题报告」右上角的设置里选：

| 方式 | 做法 |
|---|---|
| **自动**（默认） | 绑定了会话就交给它，没绑定就新开 |
| **绑定的会话** | 在某个 agent 会话的「会话」面板里点「设为修复会话」（按会话 ID 认，重启后也认得）。它空闲时把问题发进它的 pane；它在干活就排队，等它停下；它没在运行，就在新标签页恢复它（上下文还在） |
| **每次新开** | 在 pane-remote 仓库目录新开一个 agent，带插件，第一句话就是这个问题 |

新开时用哪个 agent：问题是哪家 agent 报的就用哪家（多账号的 Claude 用报告方的账号），其余用 Claude；电脑上没装就换一个装了的。也可以固定成 Claude Code / Codex / cursor-agent。

**什么时候用绑定**：问题不多、你有一个持续在迭代 pane-remote 的会话时最合适，它有上下文，修得快。问题多了或者那个会话很长，就改成「每次新开」，不打扰正在干活的会话。

## 修复的 agent 怎么做

它收到 `[pane-remote incident <id>] 读 <简报>…`，按 skill 里的「Fixing a pane-remote incident」做：

1. `incident_get` 读简报（最近几次的原文、上下文、之前的修复记录），`incident_update(status="investigating")`；
2. 在单独的分支 / git worktree 上复现、修复、跑仓库自己的测试，不动正在运行的那份代码，也不动你别的进行中的改动；
3. **部署、重启服务、推送、开 PR、合并之前都要问你**（人不在电脑前就用 `ask_phone`），等待期间报 `needs-confirm`；
4. 最后报 `fixed`（带分支或 PR 链接，一两句原因和怎么验证的）、`failed` 或 `wontfix`。除了 `investigating`，每一步都会推送给你。

防止越修越多：修复会话自己报的问题算进它正在修的这一条，不另开、不推送（新开的修复会话带 `PANE_REMOTE_INCIDENT` 环境变量；绑定的会话按 pane 认）。同一个问题同时只有一个修复会话。

第一次在 pane-remote 仓库里开 agent 时，Claude Code 会问是否信任这个目录。这一步要你来点，修复进度里会记一条，也会推送提醒你。

## 接口

| 接口 | 用途 |
|---|---|
| `GET /api/incidents` | 列表、待处理数、修复设置（`?summary=1` 只要数字） |
| `GET /api/incidents/<id>` | 详情 |
| `POST /api/incidents/<id>/action {action}` | `fix`（可带 `mode: bound\|new`）、`cancel-fix`、`ignore`、`resolve`、`reopen`、`mute`、`unmute` |
| `POST /api/incidents/report {title, detail?, ctx?}` | 手动报告 |
| `GET\|POST /api/incidents/config` | `{fixer: auto\|bound\|new, agent: auto\|claude\|codex\|cursor-agent, bound}` |

电脑端的问题经 `events.jsonl` 送到服务端（`kind: "incident"`，`op: report|update`），和 hook 用同一个文件。修复用到的 bridge 命令有 `incident-brief`、`incident-repo`、`agent available`、`agent locate`。

## 测试

`pane-remote-test` workspace 里的 pane 报的问题不推送，默认列表里也看不到（接口加 `?test=1` 才显示）；它们的修复会话也开在这个 workspace 里。自动化测试不会打扰你。
