// 服务端 / 电脑这边发给手机的提示（tr() 用）
// 来源：server/*.mjs、agent/bridge、agent/cursor-agent.mjs、agent/pane-transcript。带 {占位} 的条目按模板匹配
export default {
  'Cursor 里没找到这个操作按钮（Cursor 可能改版了）': "Couldn't find that button in Cursor (Cursor may have changed)",
  '在 Cursor 里没找到这一轮的分叉按钮（这一轮可能还没结束）': "Couldn't find the fork button for this turn in Cursor (the turn may not be finished)",
  '在 Cursor 里没找到分叉按钮（会话可能还在生成）': "Couldn't find the fork button in Cursor (the chat may still be generating)",
  '点了分叉，但 Cursor 没有切到新会话': "Clicked fork, but Cursor didn't switch to a new chat",
  // ---- 通用：bridge 报错带 error: 前缀（有的路径没去掉） ----
  'error: {msg}': 'Error: {msg}',

  // ---- server.mjs：终端 / pane / 上传 / 预览 ----
  '连接中断，重连中': 'Connection lost, reconnecting',
  'pane 已关闭': 'Pane closed',
  '这个 pane 里还没找到会话': 'No session found in this pane yet',
  '找不到这个会话': 'Session not found',
  '这个 agent 不支持分叉会话': "This agent doesn't support forking sessions",
  '{agent} 不支持分叉会话': "{agent} doesn't support forking sessions",
  '文件超过 25MB': 'File is larger than 25MB',
  '预览代理退出（{code}）': 'Preview agent exited ({code})',
  '另一台设备打开了预览': 'Preview opened on another device',
  'Cursor 模块没开（pane-remote enable cursor）': 'Cursor module is off (pane-remote enable cursor)',

  // ---- 推送通知（标题 / 正文） ----
  '测试通知：能看到这条说明推送通了': 'Test notification: if you can see this, push works',
  '电脑要打开一个网页': 'Your computer wants to open a web page',
  '{title} 做完了': '{title} finished',
  '{title} 出错停下了': '{title} stopped with an error',
  '{title} 等你操作': '{title} needs your input',
  '做完了': 'Finished',
  '出错停下了': 'Stopped with an error',
  '等你操作': 'Needs your input',
  '轮到你了': 'Your turn',
  '需要你确认': 'Needs your confirmation',
  'Cursor 做完了': 'Cursor finished',
  'Cursor 在等你': 'Cursor is waiting for you',
  '一个 Agent 会话': 'An agent session',

  // ---- cursor.mjs ----
  '正在连接电脑…': 'Connecting to computer…',
  '和电脑的连接断了': 'Lost connection to the computer',
  '连接断了（{code}）': 'Connection lost ({code})',
  '电脑那边没有回应': 'No response from the computer',

  // ---- agent/bridge ----
  '找不到 wezterm（{path}），跑 pane-remote doctor 看看': "Can't find wezterm ({path}). Run pane-remote doctor to check",
  '找不到 node（{path}），跑 pane-remote doctor 看看': "Can't find node ({path}). Run pane-remote doctor to check",
  '目录不存在': "Directory doesn't exist",
  '空文件': 'Empty file',

  // ---- agent/cursor-agent.mjs：状态 ----
  '正在启动 Cursor…': 'Starting Cursor…',
  '等待 Cursor 窗口…': 'Waiting for Cursor window…',
  '正在接入…': 'Connecting…',
  '正在退出 Cursor（有没保存的内容时 Cursor 会先问你）…': 'Quitting Cursor (it will ask first if anything is unsaved)…',
  'Cursor 没有退出（可能在等你处理保存提示），处理完再点一次': "Cursor didn't quit (it may be waiting on a save prompt). Handle it, then tap again",
  'Cursor 连接断了，重连中…': 'Lost connection to Cursor, reconnecting…',
  'Cursor 已关闭': 'Cursor closed',
  '已接入 Cursor': 'Connected to Cursor',
  'Cursor 没有打开': "Cursor isn't running",
  'Cursor 开着，但不是用调试端口启动的': "Cursor is running, but wasn't started with a debugging port",

  // ---- agent/cursor-agent.mjs：错误 ----
  'Cursor 没有启动起来': "Cursor didn't start",
  '等了 60 秒，Cursor 的调试端口还没打开': "Waited 60 seconds, but Cursor's debugging port still isn't open",
  'Cursor 打开了，但没有找到 Agents 窗口': "Cursor is open, but the Agents window wasn't found",
  '没有连上 Cursor': 'Not connected to Cursor',
  '{method} 超时': '{method} timed out',
  '页面脚本出错': 'Page script error',
  '没有找到 Cursor 的 Agents 窗口': "Couldn't find Cursor's Agents window",
  '连不上 Cursor 的调试端口': "Can't connect to Cursor's debugging port",
  '和 Cursor 的连接断了': 'Lost connection to Cursor',
  '读不到这个会话': "Can't read this session",
  'Cursor 开着但没有调试端口，需要先重启接入': 'Cursor is running without a debugging port. Restart it to connect first',
  'Cursor 还没准备好': "Cursor isn't ready yet",
  '侧边栏里没找到这个会话（可能被归档或折叠了）': "Session not found in the sidebar (it may be archived or collapsed)",
  'Cursor 里这个会话的输入框有没发出去的内容（可能是你在电脑上打的），没有往里写；先在电脑上发掉或清空':
    "This session's input box in Cursor has unsent text (maybe typed on the computer), so nothing was written. Send or clear it on the computer first",
  '没找到这个会话的输入框（会话可能还没在 Cursor 里打开完，或被折叠了），再发一次试试':
    "Couldn't find this session's input box (it may still be opening in Cursor, or be collapsed). Try sending again",
  '没找到 Cursor 的输入框': "Couldn't find Cursor's input box",
  '空消息': 'Empty message',
  '没找到新建按钮': "Couldn't find the New button",
  '这个选项已经不在了': 'This option is no longer available',

  // ---- agent/cursor-agent.mjs：会话列表 / 消息里的标签 ----
  '置顶': 'Pinned',
  '其他': 'Other',
  '执行命令': 'Run command',
  '读文件': 'Read file',
  '搜索': 'Search',
  '找文件': 'Find files',
  '网页搜索': 'Web search',
  '改文件': 'Edit file',
  '写文件': 'Write file',
  '删文件': 'Delete file',
  '列目录': 'List directory',
  'MCP 工具': 'MCP tools',
  '工具': 'Tool',
  '{text}…（太长，截掉了）': '{text}… (too long, truncated)',
  '{diff}\n…（差异太长，后面截掉了）': '{diff}\n… (diff too long, rest truncated)',

  // ---- agent/pane-transcript ----
  '（大输出，已省略）': '(large output omitted)',
  '[图片]': '[image]',
  // ---- cursor-agent：用量 ----
  'Cursor 还没登录': "Cursor isn't signed in",
  'Cursor 的登录过期了，在电脑上打开一次 Cursor 就会刷新': 'Cursor sign-in expired. Open Cursor on the computer once to refresh it',
  '查询用量失败（{status}）': 'Usage query failed ({status})',
  // ---- 看屏幕模块（server/screen.mjs、agent/screen） ----
  '看屏幕模块没开（pane-remote enable screen）': 'The screen module is off (pane-remote enable screen)',
  电脑的屏幕共享没开: 'Screen Sharing is off on the computer',
  连不上电脑的屏幕共享: "Can't reach Screen Sharing on the computer",
  窗口关掉了: 'The window was closed',
  '这个窗口录不到（可能最小化了）': "This window can't be captured (it may be minimized)",
  '看不懂 uTools 的唤出快捷键 {spec}': "Can't parse uTools's show hotkey {spec}",
} as Record<string, string>
