# host/ai：本机 agent 当 AI 提供方

这个库把本机已登录的 **Claude Code**、**Codex**、**cursor-agent** 封装成 AI 提供方，合成一个模型列表，实现 whatevertools 的 `AiCapability`（`models()` / `complete()`），另外导出 `completeAdvanced()` 作为 `platform.ai` 的底层。零依赖，Node ≥ 20（本机 v26），ESM。

```js
import { createAi } from './host/ai/index.mjs'
const ai = createAi()                 // 选项见下
await ai.models()                     // 模型列表
await ai.complete({ model: 'claude/haiku', messages }, { onChunk, callTool, signal })   // → AiMessage
await ai.completeAdvanced({ model, messages, tools, responseFormat, reasoning }, io)    // → 详细结果
ai.close()                            // 杀掉常驻备用进程（pane-host 退出时调用）
```

## 模型列表

ID 格式：`<提供方>/<模型>[@推理等级]`。

| 提供方 | 来源 | 例子 | vision | structured | tools |
| --- | --- | --- | --- | --- | --- |
| claude | 固定别名 opus / fable / sonnet / haiku；也接受精确 ID `claude/claude-haiku-4-5-20251001` | `claude/sonnet@high` | `true` | `true`（`--json-schema`） | `true`（临时 MCP） |
| codex | `~/.codex/models_cache.json` 里 `visibility=list` 的模型，推理等级取自 `supported_reasoning_levels` | `codex/gpt-5.6-luna@low` | 按 `input_modalities` | `true`（`--output-schema`） | `'experimental'`（实现了，没真测过） |
| cursor | `cursor-agent --list-models`；同一模型的 `-low/-medium/-high/-xhigh/-max` 变体并成一项，原始 ID 也能直接用 | `cursor/claude-opus-5-5@high`、`cursor/claude-opus-5-5-low-fast` | `'bridged'`（转译） | `'prompt'`（写进提示再取 JSON） | `false` |

每项字段：`id, label, icon(data: SVG), provider, model, tier('fast'|'balanced'|'strong'), efforts[], defaultEffort?, vision, structured, tools`。whatevertools 只看 `id/label/icon/vision`，其他是额外信息。

- 列表缓存一天（内存 + `~/.local/state/pane-remote/ai/models.json`）；`ai.models({ refresh: true })` 强制刷新。
- 某家没装或没登录就跳过（原因在 `ai.skipped`），这时不写缓存文件，下次再试。
- 推理等级：`model@effort`，或请求里的 `reasoning: 'low'` / `{ effort: 'low' }`（ID 里已经写了就以 ID 为准）。不在 `efforts` 里的等级直接报错（`code: 'model'`）。claude/haiku 没有推理等级。
- 没指定模型时用 `opts.defaultModel` → `claude/sonnet` → 第一个 balanced。

## 请求和结果

`completeAdvanced(req, io)`：

- `req.model`、`req.messages`（`AiMessage[]`，content 可以是字符串或内容块数组：`{type:'text'}`、OpenAI 的 `{type:'image_url', image_url:{url}}`、Anthropic 的 `{type:'image', source:{type:'base64'}}`；图片可以是 data URL 或 http(s) 网址，单张 ≤ 10MB）
- `req.tools`：`AiTool[]`（OpenAI function 格式）
- `req.responseFormat`：JSON Schema，或 OpenAI 的 `{type:'json_schema', json_schema:{schema}}`；Codex 要求严格模式（每个 object 写 `additionalProperties:false`、所有属性都在 `required` 里）
- `req.reasoning`、`req.timeoutMs`（默认 5 分钟）
- `io.onChunk({role:'assistant', content: 增量, reasoning_content?})`、`io.callTool(name, args)`、`io.signal`、`io.onEvent({type:'tool'|'tool-call', name, …})`

返回 `{ message, text, reasoning, structured, model, provider, nativeModel, effort, usage:{inputTokens, cachedInputTokens, outputTokens, reasoningTokens?, costUsd?}, ttftMs, ms, totalMs, agentTtftMs?, warm?, toolCalls:[{name,args,ms,error?}], bridge? }`。

- `ttftMs` / `ms`：目标模型这一次的首字延迟和耗时，从发请求算，**含进程启动**；`totalMs` 还包括图片下载和转译。
- 出错抛 `Error`，`code` 是 `auth`（登录失效 / 钥匙串读不到）、`aborted`、`timeout`、`model`、`tools`、`structured`（没返回合法 JSON，`e.text` 是原文）、`vision`、`unavailable`、`provider`。
- 取消：`signal` 触发后按进程组号杀子进程（先 SIGTERM，2 秒不退再 SIGKILL）。

多轮历史：三家 CLI 一次只吃一条输入，多轮对话压成 `<User>…</User><Assistant>…</Assistant>` 对话记录，让模型回最后一条。system 消息：Claude 走 `--system-prompt`（替换掉 Claude Code 自己的系统提示），另两家放进提示开头的 `<instructions>`。

## 各家怎么调用

**Claude Code**（`providers/claude.mjs`）

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose
  --model <m> --system-prompt <s> --setting-sources project --strict-mcp-config --tools ""
  --no-session-persistence --disable-slash-commands [--effort e] [--json-schema '<schema>']
  [--mcp-config '<临时 MCP>' --allowedTools mcp__wt]
```

- 不能用 `--bare`：它不读钥匙串里的登录，订阅账号用不了。
- 配置目录：沿用环境里的 `CLAUDE_CONFIG_DIR`（launchd 起的 pane-host 没有 shell 变量，要用别的配置目录就写进 `~/.config/pane-remote/host-env`），没有就是 Claude Code 默认的 `~/.claude`；`opts.claudeConfigDir` 可改。
- 工作目录是 `$TMPDIR/pane-remote-ai-work`，**必须在家目录外面**：Claude Code 会沿父目录找 CLAUDE.md，工作目录在 `~` 下面会把 `~/.claude/CLAUDE.md`（用户自己的全局说明，约 4K token）带进去。实测放外面以后一句话请求输入从 4355 token 降到 513。
- 图片作为 stream-json 输入里的 `image` 内容块原样传。
- **常驻备用进程**：stream-json 输入模式下进程起来后会等 stdin，所以每次请求时按同一组参数（模型 + system + schema + 推理等级）预先起一个备用进程，下一次同参数请求直接把消息写进去。一个进程只答一次（不共享上下文），用完马上补一个；每组参数最多一个备用，总共最多 4 个，闲置 10 分钟杀掉。带工具的请求不预热（MCP 配置每次不同）。`opts.warm: false` 关掉。
- 拿到 `result` 事件就返回，不等进程收尾（收尾还要 1~2 秒）。

**Codex**（`providers/codex.mjs`）

```
codex exec [-i 图片…] --json --ephemeral --skip-git-repo-check --ignore-user-config -s read-only
  --disable hooks --disable apps --disable plugins --disable browser_use --disable computer_use
  --disable image_generation --disable multi_agent --disable shell_tool --disable unified_exec
  -c mcp_servers={} [-c mcp_servers.wt.*=临时 MCP] -c approval_policy="never" -c project_doc_max_bytes=0
  -m <m> -c model_reasoning_effort="<e>" [--output-schema schema.json] -C <工作目录> -
```

- 提示从 stdin 传（`-`），图片写进本次请求的临时目录再 `-i`，请求结束删掉。
- `--ignore-user-config` 不读 `~/.codex/config.toml`（里面有一堆 MCP、插件、hooks）；登录仍用 `~/.codex/auth.json`，经 ssh / launchd 都能用。
- 推理等级的配置键是 `model_reasoning_effort`（实测有效）。

**cursor-agent**（`providers/cursor.mjs`）

```
cursor-agent -p --trust --mode ask --model <原始 ID> --output-format stream-json --stream-partial-output --workspace <工作目录> <提示>
```

- 提示开头固定写「不要用任何工具」：ask 模式照样能读文件 / 搜索，不写的话它会去翻工作目录。
- 输出里带 `timestamp_ms` 的 assistant 事件是增量，最后那条不带时间戳的是整段（有增量时忽略，避免重复）。

## 多模态转译（vision: 'bridged'）

cursor-agent 没有图片参数。带图请求发给它时：

1. 先用看图模型（`opts.visionBridge`，默认 `claude/haiku`；没有 Claude 就用 Codex 最轻的模型 `@low`）把本次所有图片一次转成「详细描述 + 原样 OCR 文字」（每张一节 `### Image N`）；
2. 把图片块替换成 `[Image N, converted to text by claude/haiku …] 描述 [End of image N]`，再交给目标模型；
3. 转译结果按图片 SHA-256 缓存在内存（最多 200 张），多轮对话里同一张图只转一次。

结果里的 `bridge: { model, ms, images, cached, usage }` 记录转译花费。只要目标模型 `vision !== true` 就走这条路。

## 工具调用（临时 MCP）

请求带 `tools` 时：

1. `toolbridge.mjs` 开一个 0700 临时目录，写工具清单 `tools.json`，监听 unix socket，生成随机令牌；
2. 把 `tool-mcp.mjs`（零依赖 stdio MCP 服务，写法同 `mac/agent/plugin/mcp.mjs`）配给 agent：Claude 用 `--mcp-config` + `--allowedTools mcp__wt`（-p 模式下没放行的工具会被直接拒绝），Codex 用 `-c mcp_servers.wt.command/args/env`；
3. agent 调工具 → `tool-mcp.mjs` 经 socket（带令牌）转回本进程 → `io.callTool(name, args)` → 结果（非字符串就 JSON 序列化）回给 agent；抛错时回 `isError`；
4. 请求结束关 socket、删目录，`tool-mcp.mjs` 随 agent 退出。

Claude 这条实测通了（见下）。Codex 实现了但没真测（标 `'experimental'`）。cursor-agent 能从工作区 `.cursor/mcp.json` + `--approve-mcps` 加载 MCP，但它还会加载用户全局 MCP、ask 模式下能否调用 MCP 未验证，所以先标不支持，带 tools 请求直接报 `code: 'tools'`。

## 实测（2026-10，都是最便宜的模型、极短问答）

| 用例 | 模型 | 首字（ms） | 总耗时（ms） | 结果 |
| --- | --- | ---: | ---: | --- |
| 文字（冷启动） | claude/haiku | 3311 | 5163 | ok（当时工作目录在 ~ 下，输入 4355 token） |
| 文字（冷启动，修正工作目录后） | claude/haiku | 2495 | 4708 | ok，输入 513 token |
| 同一请求（接手备用进程） | claude/haiku | 1526 | 3133 | ok |
| 看图（备用进程） | claude/haiku | 3520 | 4784 | ok，认出 “HI 42” 和红色 |
| 结构化输出 | claude/haiku | — | 4631 | 返回 `{"answer":5}` 正确；当时冒烟脚本的「增量 = 全文」检查失败（结构化输出没有文字增量），已改成结束时补一个整段 chunk，未再真测 |
| 工具调用往返 | claude/haiku | 3264 | 5234 | ok，调用 1 次，回答 4817 |
| 文字 | codex/gpt-5.6-luna@low | 4373 | 4376 | ok（但用中文回答，见限制） |
| 看图 + 结构化 | codex/gpt-5.6-luna@low | 4426 | 4432 | ok，`{"text":"…HI 42…","color":"red"}` |
| 文字 | cursor/composer-2.5-fast | 9048 | 10019 | ok |
| 看图（转译） | cursor/composer-2.5-fast | 6761 | 7686 | ok；另加 claude/haiku 转译 4810 |

（以上前几项是在「拿到 result 就返回」之前测的，总耗时里含 1~2 秒进程收尾。）Codex 没有逐字增量，首字 ≈ 总耗时。

测试命令：

```
node --test host/ai/test/unit.test.mjs     # 单元测试，不调真模型（用录制的输出 + 假的 claude / cursor-agent 脚本）
node host/ai/test/smoke.mjs [claude|codex|cursor]   # 真调用冒烟，8 项共 9 次调用
```

## 已知限制

- **Codex 没有逐字增量**：`exec --json` 一条消息生成完才出来，`onChunk` 一次给整段。要逐字得改走 `codex app-server`（JSON-RPC，有 delta 事件），没做。
- **Codex 自己的系统提示约 10K token**，去不掉。`~/.codex/AGENTS.md`（用户写给编码 agent 的说明）靠单独的 `CODEX_HOME`（`~/.local/state/pane-remote/codex-home`，见 `codex-home.mjs`）去掉了：实测每次少约 2.1K 输入 token（12269 → 10191）。登录共用：`auth.json` 是指向 `~/.codex/auth.json` 的软链，Codex 刷新令牌时若把软链换成普通文件，调用结束后拷回原文件、恢复软链。`createAi({ codexHome: false })` 关掉。
- cursor-agent 没有「不留会话」的开关，每次请求会在 `~/.cursor` 留一个聊天记录；结构化输出靠提示，模型不一定守规矩（取不到 JSON 时报 `code:'structured'`）。
- 三家都把多轮历史压成一段文字，长对话每次都要重新读全文（没有服务端缓存复用）。
- Claude 首字延迟大头是 Claude Code 自身（冷启动约 2.5 秒，备用进程约 1.5 秒）；haiku 默认开思考，`reasoning_content` 通常是空的（Claude Code 只给思考摘要）。
- `fable` 别名是否对当前账号可用没有验证（Claude Code 帮助里列了这个别名）。
- 工具名只能是 `[A-Za-z0-9_-]{1,64}`；Claude 里看到的名字是 `mcp__wt__<name>`。

## 接到 pane-host / platform.ai

已接上：pane-host 的 `services/ai.mjs`（`ai.models` call、`ai.complete` stream，工具调用走流里的请求 + `reply`），平台 core 的 `ai.chat` / `ai.models` / `platform.ai.complete`（`platform/rpc.mjs`），插件页的 `utools.ai` / `allAiModels`（`platform/runtime.js`）。代理变量从 `~/.config/pane-remote/host-env` 读（`host/config.mjs`）。下面是当时的设计说明。


- pane-host（launchd 用户会话，能读钥匙串）里建一个实例：`const ai = createAi({ env: { HTTPS_PROXY, … } })`。**launchd 的环境没有 shell 里的代理变量**，Claude Code / Codex 都靠 `HTTPS_PROXY` 出网，要从配置里读出来经 `opts.env` 传进去。退出时 `ai.close()`。
- 钥匙串读不到（例如经 ssh 调用）时，Claude / cursor 会用 `~/.config/pane-remote/triage-env` 里的 `CLAUDE_CODE_OAUTH_TOKEN` / `CURSOR_API_KEY`（`pane-agent triage-token claude|cursor` 写入，和 triage 共用）。
- 建议的 JSON-RPC：`ai.models` → `call`；`ai.complete` → `stream`，每个 `onChunk` 发一个流事件，取消流时 abort 对应的 `AbortController`；`callTool` 需要回调到插件（手机 / 服务端上的插件工具），在流里发一个 `tool-call` 请求事件，等对端回结果再 resolve。
- whatevertools 适配：`{ models: () => ai.models(), complete: (req, io) => ai.complete(req, io) }` 就是 `AiCapability`；`platform.ai` 直接用 `completeAdvanced` 拿 `structured` / `usage` / 耗时。
- 选项：`claudeConfigDir`、`env`（额外环境变量，最后合并）、`cacheDir`、`workDir`、`providers`（默认三家）、`defaultModel`、`visionBridge`、`warm`（默认 true）、`timeoutMs`、`triageEnvFile`。
