# pane-remote 插件平台

中文 | [English](en/plugins.md)

手机上的 pane-remote 可以跑插件（可选模块 `plugins`，默认开；`pane-remote disable plugins` 关掉后 `/api/plugins` 回 404，自带的预览、这台电脑、看屏幕照常）：全局悬浮按钮 → 底部抽屉（输入框 + 插件列表）→ 插件开在前台、盖住外壳。插件格式和 API 沿用 whatevertools（npm 上的 [`@whatevertools/core`](https://www.npmjs.com/package/@whatevertools/core)，兼容 uTools），平台适配器的名字是 `pane-remote`。

代码位置：

| 位置 | 作用 |
|---|---|
| `platform/` | 平台 core（跑在服务端上）：插件目录、静态文件、权限、审计、能力表与 RPC 分发 |
| `platform/runtime.js` | 注入每个插件页的运行时：`window.whatevertools`、`window.utools` 子集 |
| `web/src/lib/plugins/` | 手机前端：悬浮按钮、抽屉、容器、生命周期、权限询问 |
| `plugins/<id>/` | 插件目录（服务端启动时扫描，改了不用重启） |
| `host/`（电脑上的 pane-host） | 电脑端能力的实现方：AI、电脑剪贴板、在电脑上打开网址、只读文件（见 [host.md](host.md)） |

电脑端能力经服务端到 pane-host 的长连接（`server/host-client.mjs`，`server/server.mjs` 把它作为 `host` 交给 `createPlatform`）；pane-host 不在线时这些调用回 `EWTHOSTDOWN`，其他能力照常。

`platform/` 依赖 npm 上的 `@whatevertools/core`、`@whatevertools/compat-utools`、`@whatevertools/db-file`（0.2.x）和 `pinyin-pro`，写在根目录的 `package.json` 里，`install.sh`（`npm ci --omit=dev`）会一起装好。没装时服务端照常启动，只是没有插件功能（日志里有一行 `plugins: platform disabled`）。

## 插件格式

和 whatevertools 一样认两种描述文件：

- **uTools 格式**：`plugin.json`（`main`、`logo`、`features`、`preload`……），旁边可以放一个 `whatevertools.json` 补充身份和权限说明，不影响 uTools 发布。
- **原生格式**：`whatevertools.json`，带 `main` 字段。

目录名就是插件 id（静态文件路径、权限、数据都按它存）；描述文件里的 id 和目录名不一致时以目录名为准。

pane-remote 专属的配置写在 `whatevertools.json` 的 `paneRemote` 里：

```json
{
  "id": "hello",
  "permissions": {
    "notification": { "reason": "点「通知」时提醒你" }
  },
  "paneRemote": {
    "requires": ">=0.2.0",
    "keepAlive": 300,
    "storage": ["demo"],
    "mac": { "clipboard": false, "openExternal": false }
  }
}
```

| 字段 | 说明 |
|---|---|
| `requires` | 需要的插件 API 版本范围（`0.2.0`、`>=0.2.0`、`^0.2.0`、`~0.2.1`，空格分开表示同时满足）。不满足的插件不加载，列进插件目录的问题里。当前版本看 `whatevertools.platform.info().api` 或 `GET /api/plugins` 的 `api` |
| `keepAlive` | 后台超过多少秒就睡眠（30～3600，默认 300） |
| `storage` | 可以加入的共享存储组（`platform.storage`），没写的组不能用 |
| `mac.clipboard` | `true`：`copyText` / `clipboard.writeText` 写**电脑**的剪贴板（默认写手机的） |
| `mac.openExternal` | `true`：`shellOpenExternal` / `shell.openExternal` 在**电脑**上打开（默认在手机上打开） |

`permissions` 里的说明会出现在权限询问里；声明不会自动授予。

**版本**：`platform.info()` 返回 `{ name, version, api }`。`version` 是 pane-remote 的系统版本（`utools.getAppVersion()` 也返回它），`api` 是插件 API 版本，只在插件能用的接口变了才升（加接口升次版本，改 / 删接口升主版本）。判断某个接口能不能用，优先用 `supports()`；`requires` 只做粗筛。

示例：

- `plugins/hello/`（plugin.json + index.html）：dbStorage、通知、复制、问题报告、共享存储、在手机上提问。
- `plugins/todo/`（plugin.json + preload.js + index.html）：给 agent 的 MCP 工具（`tools` + `registerTool`）、`onDbPull` 实时更新、手机上的待办清单。
- `plugins/ai-demo/`（whatevertools.json + index.html）：`utools.allAiModels()` 选模型和推理等级、`utools.ai(…, onChunk)` 流式回答、停止（abort）、从相册附一张图（先在页面里缩到长边 1280 的 JPEG）。

## 入口匹配

抽屉的输入框按 whatevertools 的规则匹配插件声明的 `cmds`：

- **text**（字符串）：前缀 > 包含 > 子序列；中文指令支持拼音全拼和首字母（服务端算好拼音随列表下发，前端不带拼音库）
- **regex**：`"/.../flags"`，带 `minLength` / `maxLength`；匹配一切的正则按 uTools 规则忽略
- **over**：任意文字，`exclude` 正则排除，默认长度 1～10000

回车打开得分最高的入口，输入作为入口数据（`onPluginEnter` 收到 `{ code, type, payload }`）。img / files / window 类型的入口手机上用不到，不会命中。

## 容器

| 容器 | 用在 | 隔离 |
|---|---|---|
| **iframe**（默认） | `plugins/` 目录里的所有插件 | `sandbox="allow-scripts allow-forms"`，**没有** `allow-same-origin`：插件页是不透明来源，碰不到外壳的 localStorage、Cookie 和接口 |
| **inner-view** | 编进前端的平台自带视图：预览、这台电脑、看屏幕 | 同页、挂在 Shadow DOM 里（DOM 分开，外壳的样式表默认套进去）；白名单就是前端的 `registerInnerView` 注册表，目录里的插件不能声明成 inner-view |

iframe 插件的安全边界：

- 插件静态文件挂在单独的子路径 `/plugins/<id>/`，响应带 CSP：`sandbox allow-scripts allow-forms`（直接打开这个地址也是沙盒）、`frame-ancestors 'self'`（只许本站嵌入）、`form-action 'none'`。页面里的 `fetch` 可以访问外网（和 whatevertools 一样，`network` 权限只管 Node 模块）。
- 插件页发出的请求 `Origin: null`，服务端对这种请求访问任何 `/api/` 一律 403；插件只能经 postMessage 调平台，**按消息来自哪个 iframe 认插件**，插件自己说是谁不算数。
- 插件页加载自己的模块脚本、fetch 自己的文件也是跨域请求：只有 `Referer` 是同一个插件的页面时才回 `Access-Control-Allow-Origin: null`（别的网站里的沙盒 iframe 一样是 `Origin: null`，但 Referer 对不上）。

inner-view 接口（`web/src/lib/plugins/inner-view.ts`）：

```ts
registerInnerView({
  id: 'screen',
  name: '看屏幕',
  description: '看电脑屏幕，远程操作',
  icon: MonitorSmartphone,          // 抽屉里的图标组件（也可以用 logo 图片地址）
  cmds: [{ label: '看屏幕', py: 'kanpingmu', pyi: 'kpm' }, 'vnc'],   // 前端不带拼音库：中文指令的全拼 / 首字母写在这里
  keepAlive: 1800,                  // 后台多少秒后睡眠
  header: false,                    // 不要平台的插件顶栏（全屏视图自己画），运行中可以 ctx.header(show) 改
  available: () => !!appConfig.modules.screen,   // 不能用时不出现在抽屉里（地址直接打开照常进）
  mount(root: ShadowRoot, ctx) {    // ctx: action / onEnter / onLeave / header(show) / background() / close()
    // 渲染到 root；返回清理函数（睡眠、关闭时调）
    return () => {}
  },
})
```

外壳的样式表（Tailwind）默认复制一份套进 shadow root（`adoptedStyleSheets`，所有 inner-view 共用同一份），视图组件照常写 class；`pageStyles: false` 关掉。注意 shadow root 里 `document.activeElement` 只能看到宿主元素，要问 `el.getRootNode().activeElement`。

### 平台自带的插件

注册在 `web/src/lib/plugins/builtin.svelte.ts`（首屏只有注册信息和图标，组件打开时才下载）。组件收到响应式的 `active`（前台为 true），自己决定后台时怎么节流；要在睡眠后恢复的状态自己存 localStorage。

| id | 名字 | 组件 | keepAlive | 后台 | 睡眠后恢复 |
|---|---|---|---|---|---|
| `preview` | 预览 | `lib/preview/PreviewView.svelte` | 10 分钟 | 连接不断，压着 ack 不让电脑截下一张，回前台补发 | 来源、电脑模式（原有的键）；电脑上标签页都没了（Chrome 闲置 20 分钟被回收）就重新打开最后看的网页（`previewLast:<来源>`）。全屏时连插件顶栏一起藏 |
| `mac` | 这台电脑 | `lib/mac/MacPanel.svelte` | 默认 | 不再采性能 | 原有的键（性能展开、念出来的设置） |
| `screen` | 看屏幕 | `lib/screen/ScreenView.svelte`（noVNC） | 30 分钟 | WebSocket / VNC 连接保持，不再向转码代理要画面（它是手机要一帧才发一帧），回前台补要一帧增量，不重连 | 屏、清晰度、操作方式、横过来（原有的键）；看的窗口、放大和位置（`screenView`，2 小时内有效；「断开连接」后不恢复）。睡眠时断开，转码代理照常保留解锁的会话 |

三个自带插件分别跟着模块 `preview`、`mac`、`screen` 走：服务端没开的模块不出现在抽屉里（`/api/config` 的 `modules`）。看屏幕左上角的按钮是「切到后台」，「断开连接」「锁屏并离开」在它的更多菜单里。顶栏的更多菜单里有一项「插件」打开抽屉；推送「在预览中打开」导航到 `#/plugin/preview`（由插件层打开）。

## 生命周期

| 状态 | 说明 |
|---|---|
| 前台 | 显示中，同一时间只有一个；地址是 `#/plugin/<id>` |
| 后台 | 隐藏但不卸载：容器 `invisible` + `inert`，插件收到 `onPluginOut`；悬浮按钮上显示后台数量 |
| 睡眠 | 后台超过 `keepAlive`（默认 5 分钟），或 App 隐藏超过 2 分钟：卸载页面，只留记录；再打开会重新载入（App 回到前台时，原来在前台的插件自动重新载入） |
| 关闭 | 记录也去掉，「仅本次」的授权作废 |

同时挂着页面的最多 3 个，超出按最近使用（LRU）让旧的睡眠。数据（db / dbStorage）存在服务端，睡眠、重载、换手机都不丢。

前端接口（`web/src/lib/plugins/index.ts`）：`openPlugin(id, payload?)`、`closePlugin(id)`、`backgroundPlugin(id)`、`sleepPlugin(id)`。地址 `#/plugin/<id>` 和前台插件双向同步：打开地址就把插件开到前台；插件到前台地址跟上；切后台 / 关掉时回到打开插件之前的视图（换掉当前这条历史，不后退，免得冷启动时退出 App）；地址离开插件（返回手势、推送跳到会话、选了别的会话）时前台插件切到后台。

## 权限

直接用 whatevertools core 的 `PermissionManager`（Chrome 式）：

- 默认询问；插件自己的数据库（`storage`）和问题报告（`platform.incident`）默认放行
- 询问弹在发起调用的那台手机上：**仅本次 / 始终允许 / 禁止 / 以后再说**
- 「以后再说」（或关掉）算本次拒绝；连续 3 次自动转为禁止（插件关掉重开也累计）
- 「仅本次」的有效期是插件这次打开：关闭插件后作废
- 结论按插件存在服务端数据目录的 `plugins/permissions.json`；插件顶栏的盾牌按钮可以逐项改成 允许 / 询问 / 禁止，或全部重置
- 询问 5 分钟没人回答：这次调用失败，不记任何结论

pane-remote 专属的权限项：

| id | 默认 | 说明 |
|---|---|---|
| `platform.incident` | 授予 | 把插件发现的问题记进问题报告 |
| `platform.storage` | 询问（按组） | 读写共享存储组；「始终允许」只对问的那个组有效 |
| `platform.agent` | 询问 | 在手机上提问、推送 |

## 能力表与 support

每次能力调用：查能力表 → 查权限（需要时问手机）→ 记审计 → 交给实现方：

| 实现方 | 说明 |
|---|---|
| 服务端（server） | 数据库、推送、问题报告、共享存储、在手机上提问 |
| 前端（web） | 复制、打开链接、打开别的插件：服务端查完权限回 `$delegate`，前端执行 |
| 插件页（local） | 生命周期、平台信息、db / dbStorage 的同步读写（本地副本） |
| 工具运行时（tools） | agent 经 MCP 调插件工具时，在服务端的沙盒子进程里跑插件的 preload（见「插件工具」） |
| 电脑（pane-host） | 已接上：AI（`ai.chat` / `ai.models` / `platform.ai.complete`）、电脑剪贴板文字、在电脑上打开网址、只读文件（`platform.fs.*`）。pane-host 不在线回 `EWTHOSTDOWN`。还没接上的（截屏、键鼠、子进程、shellOpenPath、剪贴板文件/图片……）回 `EWTUNSUPPORTED`，错误里写明「要电脑上的 pane-host，这一项还没接上」 |

审计：每次调用记一行（插件、方法、结果 ok / denied / unsupported / error / delegated / cancelled、实现方、耗时，不记参数），内存留 500 条，同时写 `plugins/audit.jsonl`（2MB 轮转）。`GET /api/plugins/audit[?plugin=]` 查看。

support 表初稿（完整的以 `GET /api/plugins/support` 为准，whatevertools 规格里的每一项都有一行）：

| API（uTools 旧名） | support | 实现方 | 备注 |
|---|---|---|---|
| `onPluginEnter` / `onPluginOut` / `onPluginReady` / `outPlugin` | emulated | 插件页 | |
| `db.put/get/remove/bulkDocs/allDocs` | emulated | 插件页 + 服务端 | 同步读写在本地副本上，改动 50ms 内推给服务端，按 rev 裁决（同 CouchDB） |
| `db.postAttachment` | emulated | 服务端 | 返回 Promise（uTools 是同步的） |
| `db.getAttachment` | partial | 服务端 | 同步版只能读这次打开里读过的；用 `db.promises.getAttachment` |
| `dbStorage.setItem/getItem/removeItem` | emulated | 插件页 + 服务端 | |
| `showNotification` | emulated | 服务端 | 手机开着 pane-remote 时是页内提示，否则推送 |
| `copyText` | emulated | 前端 / 电脑 | 默认写**手机**的剪贴板；`paneRemote.mac.clipboard` 为 true 时写电脑的 |
| `shellOpenExternal` | emulated | 前端 / 电脑 | 只认 http(s)；默认在手机上打开，`paneRemote.mac.openExternal` 为 true 时在电脑上打开 |
| `ai` / `allAiModels` | emulated | 电脑 | 本机已登录的 Claude Code / Codex / cursor-agent，见下面「AI」 |
| `registerTool` | emulated | 插件页 / 工具运行时 | `ai` 的工具调用；描述文件 `tools` 里声明了的，还经 MCP 给 agent 用（见「插件工具」） |
| `onDbPull` | emulated | 插件页 / 工具运行时 | 别处（agent 经插件工具、别的手机）改了数据时调用，见「数据同步」 |
| `redirect` | partial | 前端 | 按插件 id 或功能指令打开别的插件 |
| `getFeatures`、`isDarkColors`、`getAppName`、`getAppVersion`、`isMacOS` 等 | emulated | 插件页 | `isMacOS/isWindows/isLinux` 都是 false（插件跑在手机上） |
| `setExpandHeight` | mock | 插件页 | 插件总是占满屏幕 |
| `shellOpenPath`、`showOpenDialog`、`getPath`、`getPluginTempPath`、`copyImage`、`copyFile`、`getCopiedFiles`、`screenCapture`、`simulate*`、`hideMainWindowPaste*`、`readCurrentFolderPath`、`getNativeId`、`getUser`、`runFFmpeg`、`ubrowser` | none | 电脑（还没接上） | |
| `sharp`、`requestSchedule`、`setFeature`、面板输入框、`findInPage`、付费 | none | 无 | sharp 以后可以用 `@whatevertools/sharp-canvas` 在手机上做 |
| `require('fs')` 等 Node 模块（preload） | none | 无 | preload 照常按 `<script>` 执行，`require` 一律报清楚的错；读电脑上的文件用 `platform.fs` |

插件可以先用 `whatevertools.supports(name)` 判断（不支持的返回 `false`，旧名也认）。不支持的 API 也有同名函数，调用时抛 `code: 'EWTUNSUPPORTED'`。

## platform.* API（pane-remote 专属）

都在 `window.whatevertools.platform` 下（`getApi().platform` 同）：

```js
const wt = window.whatevertools

wt.platform.info()                       // { name: 'pane-remote', version, plugin }

// 问题报告：进 pane-remote 现有的问题报告（来源 plugin:<id>，按指纹去重，按问题报告的推送规则推）
await wt.platform.incident.report({ title: '同步失败', detail: '…', severity: 'normal' /* high|normal|low */ })
// 插件页里未捕获的异常、未处理的 Promise、console.error 会自动上报（每次载入最多 20 条，服务端再按插件每分钟 30 条限流）

// 共享存储：所有在 paneRemote.storage 里声明了同一个组的插件共用（存服务端数据目录，单个值 ≤256KB，每组 ≤2000 个键）
await wt.platform.storage.set('demo', 'hits', 1)
await wt.platform.storage.get('demo', 'hits')     // 没有就是 null
await wt.platform.storage.remove('demo', 'hits')
await wt.platform.storage.keys('demo')

// 在手机上问你（和 agent ask_phone 同样的卡片；手机不在看时推送，点推送回来照样能答；POST /api/agent/answer 也收）
const r = await wt.platform.agent.ask({ question: '要继续吗？', options: ['继续', '算了'], timeout: 600, confirm: false })
// → { answered: true, answer: '继续', text: '' } / { answered: true, answer: '', text: '自己写的回答' } / { answered: false, reason: 'timeout' }

// 推送（和 notify_phone 一样限频：同一个插件 20 秒一条、全部每小时 20 条）
await wt.platform.agent.notify({ title: '导出完成', body: '3 个文件' })   // → { sent: true } / { sent: false, reason: 'rate-limited' }

// 以后加的方法不用改运行时也能调
await wt.platform.call('platform.xxx', { … })
```

## AI

模型来自电脑上已登录的 Claude Code / Codex / cursor-agent（`host/ai`，经 pane-host）。要 `ai` 权限（默认询问），消耗对应账号的额度。

```js
const models = await utools.allAiModels()      // = whatevertools.ai.models()
// [{ id: 'claude/sonnet', label, icon, provider: 'claude', vision: true | 'bridged' | false,
//    efforts: ['low','medium','high','xhigh','max'], defaultEffort?, tier: 'fast'|'balanced'|'strong', structured, tools }, …]

// 流式：传了 onChunk 时 resolve undefined；不传则 resolve 完整的 { role: 'assistant', content }
const p = utools.ai({ model: 'claude/sonnet@high', messages: [{ role: 'user', content: [
  { type: 'text', text: '这张图里写了什么？' },
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,…' } },   // 单张 ≤ 10MB，整个请求 ≤ 15MB
] }] }, (chunk) => { /* { role, content: 增量, reasoning_content? } */ })
p.abort()   // 取消：电脑上的 agent 进程被杀掉，p 以 code: 'aborted' 失败

// 工具：tools 用 OpenAI function 格式；agent 调用时运行 registerTool 注册的函数（没有就找 window 上的同名函数，uTools 习惯）
utools.registerTool('add', ({ a, b }) => ({ sum: a + b }))
await utools.ai({ model: 'claude/haiku', messages, tools: [{ type: 'function', function: { name: 'add', description: '加法', parameters: { … } } }] })

// 详细版（pane-remote 专属）：结构化输出、推理等级、用量和耗时
const r = await whatevertools.platform.ai.complete({ model: 'claude/haiku', messages, responseFormat: { type: 'object', … }, reasoning: 'low' }, { onChunk, signal })
// → { text, structured, reasoning, model, provider, usage: { inputTokens, outputTokens, … }, ttftMs, ms, totalMs, toolCalls, bridge? }
```

- 模型 ID：`<提供方>/<模型>[@推理等级]`；推理等级不在 `efforts` 里报错。`vision: 'bridged'`（cursor）的模型收到图片时先用看图模型转成文字。
- 错误码：`aborted`（取消）、`EWTHOSTDOWN`（pane-host 不在线）、`EAI_AUTH`（电脑上那个 agent 没登录）、`EAI_MODEL`、`EAI_TIMEOUT`、`EAI_TOOLS`、`EAI_STRUCTURED`、`EAI_PROVIDER`……（`EAI_` + host/ai 的 code）。
- 插件页睡眠 / 关闭时，它还在跑的 AI 调用会被取消。
- 电脑上一个已登录的 agent 都没有时，模型列表是空的。
- 链路：插件页 `call {stream: true}` → 前端 → 服务端 WS（`chunk` 片段、`tool` 回调插件页的工具、前端回 `tool-result`、`cancel`）→ pane-host 的 `ai.complete` 流（工具调用是流里的请求，服务端用 `reply` 回结果，见 [host.md](host.md)）。

## 电脑剪贴板、在电脑上打开

```js
await whatevertools.platform.mac.clipboard.readText()       // 权限 clipboard.read
await whatevertools.platform.mac.clipboard.writeText('…')   // 权限 clipboard.write
await whatevertools.platform.mac.openUrl('https://…')       // 权限 shell.external（按网址问）
```

也可以在描述文件里写 `paneRemote.mac.clipboard` / `paneRemote.mac.openExternal`，让标准的 `copyText` / `shellOpenExternal` 直接走电脑。

在电脑上打开网址用的是 `/usr/bin/open`，**不经过**「网址转手机」模块装的 `open` 包装（它在你此刻在用手机时会把网址转回手机）。插件想在手机上打开就用默认的 `shellOpenExternal`，想在电脑上打开（比如让电脑上的浏览器下载东西）才用 `platform.mac.*`。

## 电脑上的只读文件（platform.fs）

```js
await whatevertools.platform.fs.roots()                 // [{ root: 'private', path, exists }, { root: '~/Documents/notes', … }]
await whatevertools.platform.fs.list('')                // 相对路径 = 插件私有目录 ~/.local/share/pane-remote/plugins-data/<id>/
await whatevertools.platform.fs.readText('notes/a.md')  // 最多 10MB；{ maxBytes } 可以只读开头
await whatevertools.platform.fs.read('~/Documents/notes/a.png')   // Uint8Array
await whatevertools.platform.fs.stat('/Users/me/Documents/notes/a.md', { root: '~/Documents/notes' })
```

- 只读，没有写、删、改名。
- 私有目录：权限 `fs.plugin`（默认允许），第一次用到时在电脑上建（0700）。
- 别的目录：用户在插件顶栏盾牌 → 「可以读的电脑文件夹」里加（绝对路径或 `~/…`，不能是整个家目录或 `/`，每个插件最多 20 个），第一次读时再按目录问一次 `fs.read`（「始终允许」只对那个目录有效）。插件自己不能加。
- 服务端先按路径（统一成 `~/…`、去掉 `..`）找到所属的根目录、查权限；pane-host 再按真实路径（跟随符号链接后）核对一遍必须落在那个根目录里。`.ssh`、`.gnupg`、钥匙串、`~/.config/pane-remote` 不管怎么加都不给读。

## 插件工具（给 agent 的 MCP）

和 uTools 的「插件对外提供 MCP 工具」一样：插件在描述文件里声明工具，在 preload 里用 `utools.registerTool` 实现；在 pane-remote 里启动的 agent（Claude Code / Codex / cursor-agent，注入了 pane-remote 的 MCP）会自动看到这些工具，名字是 `plugin_<插件 id>_<工具名>`。同一个插件原样放进 uTools 也能用。

```jsonc
// plugin.json（uTools 格式；原生格式写在 whatevertools.json 里也一样）
{
  "preload": "preload.js",
  "tools": {
    "add": {
      "description": "写给 agent 看的：这个工具做什么、什么时候用",
      "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] },
      "outputSchema": { … }            // 可选；声明了的话结果也作为 structuredContent 返回
    }
  }
}
```

```js
// preload.js
utools.registerTool('add', async ({ title }, ctx) => {
  // ctx.requestId；pane-remote 另给 ctx.caller = { agent: 'claude', pane: 3, cwd: '/path/to/project' }（uTools 里没有）
  const r = utools.db.put({ _id: 'todo/' + Date.now(), title, by: ctx?.caller?.agent })
  return { id: r.id }
})
```

怎么跑的：

- agent 调用时，服务端在一个**无界面的工具运行时**里跑插件的 preload（`platform/tool-runtime.mjs`），收集 `registerTool` 注册的函数再执行；手机不用开着插件。运行时闲 10 分钟退出，插件文件改了自动换新的。
- 运行时是沙盒子进程：Node 的 `--permission` 只放行读它自己这个文件（读写不了文件、起不了子进程），环境变量是空的；插件代码在 vm 的新上下文里，只有 `utools` / `whatevertools`、`console`、定时器、`fetch`、`URL`、`crypto` 这些。`require` 一律报错。
- 能用的 API：`utools.db` / `dbStorage`（本地副本，规则同插件页）、`registerTool`、`onDbPull`、`showNotification`（推送）、`whatevertools.platform.*`（经服务端，照常查权限、记审计；没有界面能弹询问，没授权过的按「以后再说」）。剪贴板、打开链接、界面相关的回「不支持」。
- 工具返回之前先把写入推给服务端：agent 拿到结果时数据已经落盘，打开着的插件页也马上更新（见下面「数据同步」）。
- 权限 `mcp`（默认询问）：第一次调用时用「在手机上问你」的卡片问（总是推送），选项 始终允许 / 仅这次 / 禁止；5 分钟没回答这次调用失败，下次调用再问（连续 3 次没答自动转为禁止）。禁止之后这个插件的工具不再出现在 agent 的列表里。插件顶栏的盾牌里可以随时改。每次调用记审计（方法名 `mcp.<工具名>`）。
- 链路：agent → 注入的 MCP（`agent/plugin/mcp.mjs` 启动器 + `mcp-server.mjs`）→ 电脑上 pane-host 的 socket（`plugins.tools.list` / `plugins.tools.call`）→ 服务端连上 pane-host 时开着的反向通道（`relay.serve` 流）→ 服务端的工具宿主（`platform/tools.mjs`）。local 和 relay 模式一样。
- 插件工具列表一变（插件装上 / 改了 / 删掉、权限改成禁止），服务端 5 秒内告诉 pane-host（`plugins.tools.changed`），pane-host 推给订阅着 `plugins.tools` 主题的 MCP，MCP 发 `tools/list_changed`，agent 马上重新拉；另外每 5 分钟兜底刷新一次。服务端或 pane-host 不在线时插件工具调用失败，自带的工具照常。
- 只认声明在描述文件 `tools` 里、插件有 preload 的工具；工具名只许字母数字 `_` `-`，`inputSchema` 必须是对象。`platform.agent.tools.register`（运行中注册）不做：工具列表要在插件没运行时就能给出来。

示例：`plugins/todo/`（待办）。

## 数据同步

插件的数据存在服务端，插件页和工具运行时各有一份本地副本（同步读写），改动推给服务端按 rev 裁决。别处的改动会推过来：

- 服务端收到一个副本推上来的改动后，推给其他打开着这个插件的手机页面（断开期间排队，连上补发）和正在跑的工具运行时
- 页面和服务端的连接断过再连上时，页面拿一次全量（`db.pull`）合并
- 收下的改动交给 `utools.onDbPull(docs => …)`（= `whatevertools.db.onPull`）的回调：插件在这里重画界面。还没推上去的本地改动不会被覆盖，推上去后由服务端裁决

## 服务端接口

| 接口 | 说明 |
|---|---|
| `GET /api/plugins` | 插件列表（描述 + 带拼音的功能指令） |
| `GET /api/plugins/support` | support 表 |
| `GET/POST /api/plugins/permissions` | 某个插件的权限结论；改单项 / 全部重置 |
| `GET /api/plugins/audit` | 最近的调用审计 |
| `GET /api/plugins/asks` | 插件问的、还没答的问题 |
| `GET/POST /api/plugins/fs-dirs` | 用户允许插件读的电脑目录：`?plugin=` 查；`{plugin, dirs}` 整个替换 |
| `GET /plugins/_runtime.js`、`/plugins/<id>/…` | 运行时、插件静态文件（HTML 里注入运行时和启动数据） |
| `WS /api/platform/ws?client=<id>` | 前端 ↔ 平台：`call`/`result`、`prompt`/`prompt-answer`、`asks`、`vis`、`session-end`；流式调用（`call` 带 `stream: true`）另有 `chunk`、`tool`/`tool-result`、`cancel`；断线重连带同一个 client id，断开期间的结果和询问补发 |

`POST /api/agent/answer` 也能答插件的问题（id 是插件问题的 id 时由平台收）。推送带 `plugin: <id>`，点开进 `#/plugin/<id>`。

## 已知限制

- `wt pack --target web` 打出来的页面（自带完整的 whatevertools 浏览器运行时）要 IndexedDB / localStorage，而插件 iframe 没有 `allow-same-origin`，跑不起来。
- preload 里的 `require('node:fs')`、`electron` 等 Node 模块不支持；读电脑上的文件用 `platform.fs`。
- `utools.sharp`、`getPluginTempPath` 还没有。插件工具只能在描述文件 `tools` 里声明，不能运行中注册。
