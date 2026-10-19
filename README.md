# pane-remote

中文 | [English](README.en.md)

用手机查看和操作电脑上 WezTerm 里的终端，Claude Code / Codex 会话有专门的对话视图、推送提醒和会话管理。
不经过任何第三方服务器：手机和电脑之间走你自己的 Tailscale 网络，只有你的账号能打开。

## 能做什么

**基础版**（装完就有）

- 所有 WezTerm pane 的实时画面，手机上直接打字、按键（键盘栏、方向摇杆、Ctrl / Shift / Option）、滑动滚动、轻点
- 新建标签页、拆分、关闭、重命名 pane，在电脑上切到某个 pane；电脑上把 pane 拖窄了，手机上一键调回「适合手机」的宽度（或均分整个标签页）
- Claude Code / Codex：
  - 对话视图（按会话记录排版，比终端好读）
  - **分叉会话**：带着当前会话的全部上下文在新 pane 里开一个新会话（对话栏「分叉」、pane 菜单、拆分时都能选）
  - 同目录新开会话、常用斜杠命令
  - 会话里的定时任务面板：看排期和上次结果，一键立即执行 / 重启 / 停止
  - 焦点跑到后台 agent 列表时提醒并一键回到输入框
- 推送通知：某个 pane 在等你选择 / 确认、或者一轮做完时推到手机（你在电脑前时不推）
- 待办收件箱：所有在等你操作的 pane 集中处理
- 传文件到电脑、长按识别终端里的链接
- 自动重连 + 手动重连

**增强版模块**（按需开启）

| 模块 | 作用 | 开启 |
|---|---|---|
| 预览浏览器 | 手机上看电脑这边的网页（localhost、内网都行）和文件（文件夹、图片、视频、PDF、Markdown、代码），支持电脑模式（桌面 UA、横屏全屏） | 有 Chrome 时默认开；`pane-remote enable preview` |
| 网址转手机 | 电脑上打开链接时，如果你正在用手机，就转到手机的预览里打开 | `pane-remote enable openUrl` |
| Cursor 映射 | 手机上看和操作 Cursor IDE：会话、消息、待办 / 未读、命令输出、改动差异、内置浏览器 | `pane-remote enable cursor`，见 [docs/cursor.md](docs/cursor.md) |
| 看屏幕 | 手机上看和操作电脑屏幕（一块显示器或单个窗口）：点、拖、滚动、触控板模式、打字（含中文）、多指手势、后台打开 app。走系统自带的屏幕共享，画面在电脑上转码后再传 | `pane-remote enable screen`，见 [docs/screen.md](docs/screen.md) |
| 中转模式 | 电脑本身跑不了 Tailscale 时，经一台在你 tailnet 里的服务器转发 | 见 [docs/relay.md](docs/relay.md) |
| 持久化 pane | WezTerm 窗口关了 pane 也不丢，手机照样能连 | 见 [docs/advanced.md](docs/advanced.md) |

## 需要什么

| | 说明 |
|---|---|
| 电脑 | macOS（Apple 芯片或 Intel） |
| 终端 | [WezTerm](https://wezfurlong.org/wezterm/)，安装脚本会装；手机上看到的就是 WezTerm 里的 pane |
| 网络 | [Tailscale](https://tailscale.com)，电脑和手机登录同一个账号。tailnet 要打开 **MagicDNS** 和 **HTTPS Certificates**（管理后台 → DNS）。自建的 Headscale 一般签不了 HTTPS 证书，用不了 |
| 手机 | iPhone（iOS 16.4 以上才有推送）或 Android，装 Tailscale App |
| 可选 | Claude Code、Codex（对话视图、分叉等功能）；Chrome（预览浏览器）；Cursor（Cursor 模块）；Xcode 命令行工具（看屏幕模块） |

安装脚本用 [Homebrew](https://brew.sh) 装 WezTerm 和 Tailscale；Node.js 用电脑上已有的（20 以上），没有就从 nodejs.org 下载官方版本并校验，只给 pane-remote 自己用。

## 安装

```bash
git clone <仓库地址> ~/pane-remote
cd ~/pane-remote
./install.sh
```

装完终端里会给出一个 `https://<电脑名>.<tailnet>.ts.net/` 地址（装了 qrencode 还会显示二维码）。手机上：

1. 打开 Tailscale App，登录和电脑同一个账号
2. Safari 打开那个地址
3. 分享 → 添加到主屏幕，从主屏幕打开（推送通知只在这种方式下能用），在右上角的铃铛里打开通知

**已经开着的 Claude / Codex 会话要重开一次**，新的 hook 才会生效（推送、对话视图要用）。用 Codex 的话，还要在 Codex 里确认信任新加的 hook。

常用参数：

```bash
./install.sh --yes                       # 全用默认选项
./install.sh --chrome                    # 没装 Chrome 又想用预览浏览器：用 Homebrew 装 Google Chrome
./install.sh --login you@example.com     # 允许访问的 Tailscale 账号（默认是电脑登录的账号；电脑是标签设备时必须指定）
./install.sh --no-brew                   # 自己装好 WezTerm、Tailscale，不用 Homebrew
./install.sh --lang en                   # 命令行用英文（默认按系统语言）
```

## 日常命令

```bash
pane-remote doctor            # 自检：每一项有问题都会给出修复办法
pane-remote status            # 服务在不在跑
pane-remote restart | logs
pane-remote stop | start      # 停 / 开服务；stop 连预览用的 Chrome 一起关（下次用预览会自动再开）
pane-remote enable preview    # 开 / 关模块：preview、openUrl、cursor、screen
pane-remote disable openUrl
pane-remote init              # 改了配置、换了电脑名、装了新的 Claude 配置目录后重跑一次（保留原有配置）
pane-remote uninstall         # 停服务、撤掉 tailscale serve、还原 hook；加 --purge 连配置和数据一起删
```

没有 `pane-remote` 命令时用 `~/pane-remote/bin/pane-remote`。

## 配置

`~/.config/pane-remote/config.json`（init 生成，改完 `pane-remote restart`）：

| 键 | 含义 |
|---|---|
| `allowedLogins` | 允许访问的 Tailscale 登录名 |
| `serveHosts` | tailscale serve 的主机名（init 自动填） |
| `port` | 本机服务端口，默认 8787 |
| `presets` | 新建 pane 时可选的启动命令，比如 `{"label": "Claude Code", "command": "claude"}` |
| `claudeWrappers` | Claude 配置目录 → 启动命令。用多个 `CLAUDE_CONFIG_DIR` 时，分叉会话要用同一个配置目录启动 |
| `modules` | 模块开关 |

## 安全

- 服务只监听 `127.0.0.1`，由 `tailscale serve` 对你的 tailnet 提供 HTTPS，不暴露到公网
- 每个请求都要带 tailscale serve 注入的访问者身份（`Tailscale-User-Login`），不在 `allowedLogins` 里的一律拒绝；还要求 Host 是你电脑的 ts.net 主机名，挡住电脑上浏览器里的网页借 localhost 调接口
- 所有改动类请求（非 GET）都必须来自本站页面（校验 Origin / Sec-Fetch-Site），挡住别的网页借你的登录身份发请求
- 操作终端都经过 `agent/bridge`：只认固定的几种指令，参数逐个校验，不执行任意 shell
- 预览浏览器的文件服务只监听本机、地址带随机令牌，只能读家目录和 `/tmp`；生成的页面有严格的 CSP，Markdown 经 DOMPurify 清洗，脚本库都从本机提供；原始文件在沙箱里给出
- 预览里的 Markdown 只显示本机的图片，外网图片（徽章之类）不加载，避免打开文件时向外发请求
- **前提：这台 Mac 只有你自己在用。** 服务信任本机 127.0.0.1 上带的身份请求头，电脑上的其他用户或恶意程序能伪造它；预览用的无界面 Chrome 的调试端口也只靠「只监听本机」保护（不过能在你电脑上跑程序的话，本来也能直接操作你的终端）。中转模式下，中转服务器也要是你一个人专用的
- **这相当于用手机远程操作你的电脑终端**：别把 `allowedLogins` 加成别人的账号，别用 `tailscale funnel` 把它开到公网

## 常见问题

**打开地址显示 forbidden**：手机上 Tailscale 登录的账号不在 `allowedLogins` 里，或者你是通过 IP 而不是 ts.net 地址打开的。

**对话视图、推送没反应**：会话是装 hook 之前开的，重开一次；`pane-remote doctor` 看「hook 有在记录事件」那一项。

**WezTerm 连不上**：电脑上要开着 WezTerm 窗口；想关窗口也能用，见 [docs/advanced.md](docs/advanced.md) 的持久化配置。

**tailscale serve 失败**：tailnet 没开 HTTPS Certificates，或者 443 端口被别的服务占了（init 会自动改用 8443）。

## 目录

```
install.sh          一键安装
bin/pane-remote     命令入口（lib/cli.mjs）
server/             服务端（手机网页的后端）
agent/              电脑这边的脚本：bridge（操作 WezTerm 的唯一入口）、hook、会话记录解析、预览浏览器、Cursor 适配、看屏幕（screen/）
web/                手机网页源码（Svelte），构建产物在 public/
relay/              中转模式的辅助命令
scripts/audit.mjs   发布前审计：查个人信息、内网地址和密钥
```

改了前端要重新构建：`npm run build`（会在 web/ 里装开发依赖）。

## 许可证

[MIT](LICENSE)
