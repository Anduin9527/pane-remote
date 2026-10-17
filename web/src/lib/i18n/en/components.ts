// 组件：会话面板、定时任务、输入框、新建 / 拆分、pane 列表与菜单、快捷键、通知、收件箱、阅读模式等
// （取消 / 关闭 / 打开 / 复制 / 删除 / 保存 / 发送 / 重连 在 common.ts；分叉 / 回到底部 / 推送通知 / 选择 pane 等在 app.ts；做完了 / 在等你 / 搜索 / 等你操作 在 server.ts）
export default {
  '已开启。pane 出现选择器、权限确认或 y/n 提示，或 Cursor 会话在等你批准时会推送；你正在手机上看的 pane / 会话、或你最近 2 分钟在用电脑时不推。同一个 pane 15 秒内只推一次。':
    "On. You'll get a push when a pane shows a picker, permission prompt or y/n question, or a Cursor session waits for your approval. Not sent for the pane / session you're viewing on the phone, or if you used the computer in the last 2 minutes. At most one push per pane every 15 seconds.",
  '开启后，任何 pane 或 Cursor 会话在等你选择或确认时会推送到这台手机，点通知直接打开它。':
    'When on, any pane or Cursor session waiting for your choice or confirmation pushes to this phone; tap the notification to open it.',
  'Claude / Codex / Cursor 一轮做完也推送': 'Also push when a Claude / Codex / Cursor turn finishes',
  'Claude / Codex 要求会话启动时已加载 hook，旧会话重开后才生效；Cursor 不用': 'Claude / Codex need the hook loaded at session start (reopen older sessions); Cursor needs nothing',
  // 通用
  '、': ', ',
  '运行中': 'Running',
  '读取中…': 'Loading…',
  '刷新': 'Refresh',
  '完成': 'Done',
  '确认': 'Confirm',
  '新标签': 'New tab',
  '右侧': 'Right',
  '下方': 'Below',
  '分叉失败：{msg}': 'Fork failed: {msg}',
  '已分叉到新 pane（新会话，带着原来的上下文）': 'Forked to a new pane (new session with the original context)',
  '{agent} 正在工作…': '{agent} is working…',

  // claude/crons.svelte.ts
  '每 {n} 分钟': 'Every {n} min',
  '每小时 {m}': 'Hourly at {m}',
  '每 {n} 小时 {m}': 'Every {n}h at {m}',
  '每天 {t}': 'Daily at {t}',
  '{mon}月{dom}日 {t}': '{mon}/{dom} {t}',
  '昨天 {t}': 'Yesterday {t}',
  '明天 {t}': 'Tomorrow {t}',
  '不到 1 分钟': 'under 1 min',
  '{n} 分钟': '{n} min',
  '{h} 小时 {m} 分': '{h}h {m}m',
  '{h} 小时': '{h}h',
  '{n} 天': '{n} days',
  '{d}后': 'in {d}',
  '{d}前': '{d} ago',

  // claude/CronSheet.svelte
  '立即执行': 'Run now',
  '停止': 'Stop',
  '重启': 'Restart',
  '恢复': 'Restore',
  '已发立即执行': 'Run sent',
  '已发停止': 'Stop sent',
  '已发重启': 'Restart sent',
  '已发恢复': 'Restore sent',
  '已让会话立即执行「{name}」': 'Asked the session to run "{name}" now',
  '已让会话停止「{name}」': 'Asked the session to stop "{name}"',
  '已让会话重启「{name}」': 'Asked the session to restart "{name}"',
  '已让会话恢复「{name}」': 'Asked the session to restore "{name}"',
  '会话正忙，会排在当前这轮之后处理': "The session is busy; it'll handle this after the current turn",
  '{d}后自动过期': 'Expires in {d}',
  '定时任务（{n}）': 'Scheduled tasks ({n})',
  '只活在这个 Claude 会话里；按钮会往会话里发一条提示词，让它自己处理':
    'These live only in this Claude session; the buttons send it a prompt to handle them',
  '这个会话现在没有定时任务': 'No scheduled tasks in this session',
  '执行中': 'Running',
  '排期': 'Schedule',
  '下次': 'Next',
  '上次': 'Last',
  '（手动）': ' (manual)',
  '共跑过 {n} 次': 'ran {n} times',
  '还没跑过': 'Not run yet',
  '过期': 'Expiry',
  '，要继续就点「重启」': '; tap "Restart" to keep it',
  '这一轮还没出结果': 'No result for this run yet',
  '收起提示词': 'Hide prompt',
  '查看提示词': 'Show prompt',
  '再点一次停止': 'Tap again to stop',
  '最近停掉的（3 天内）': 'Recently stopped (last 3 days)',
  '过期于 {t}': 'expired {t}',
  '已跑完于 {t}': 'finished {t}',
  '停止于 {t}': 'stopped {t}',
  '跑过 {n} 次': 'ran {n} times',

  // claude/ClaudeSheet.svelte
  '默认': 'default',
  '已新开 {agent}': 'Started a new {agent}',
  '没成功：{msg}': 'Failed: {msg}',
  '右侧拆分': 'Split right',
  '下方拆分': 'Split down',
  '{agent} 会话': '{agent} session',
  '账号 {name}': 'account {name}',
  '已复制会话 ID': 'Session ID copied',
  '复制 ID': 'Copy ID',
  '新会话带着现在的全部上下文，原会话不受影响': 'New session with all current context; the original is untouched',
  '同目录新开 {agent}': 'New {agent} in same folder',
  '全新会话': 'Fresh session',
  '常用命令': 'Common commands',
  '发到当前会话': 'Sent to the current session',

  // claude/ChatView.svelte
  '读取对话…': 'Loading conversation…',
  '还没有对话记录': 'No conversation yet',
  '{n} 次工具调用': '{n} tool calls',
  '有报错': 'Errors',

  // Composer.svelte
  '{name} 超过 25MB': '{name} is over 25 MB',
  '上传 {name}…': 'Uploading {name}…',
  '已传到电脑：{name}': 'Uploaded to computer: {name}',
  '上传失败：{msg}': 'Upload failed: {msg}',
  '没发出去：{msg}': 'Not sent: {msg}',
  '焦点在后台 agent 列表上，没能自动回到输入框，没有发送':
    "Focus is on the background agent list and couldn't return to the input box; not sent",
  '已填进电脑上的输入框，没有提交': 'Typed into the input box on the computer, not submitted',
  '回复 {agent}…': 'Reply to {agent}…',
  '输入文字…': 'Type here…',
  '收起编辑区': 'Collapse editor',
  '展开成多行编辑': 'Expand to multi-line editor',
  '传文件到电脑': 'Send file to computer',
  '回车换行': 'Enter inserts a newline',
  '，长按发送 = 只填入不提交': '; long-press Send to type without submitting',
  '发送时附带回车': 'Press Enter after sending',

  // CreatePane.svelte
  '只开 shell': 'Shell only',
  '自定义…': 'Custom…',
  '分叉这个会话': 'Fork this session',
  '创建失败：{msg}': 'Create failed: {msg}',
  '拆分 #{pane}（右侧）': 'Split #{pane} (right)',
  '拆分 #{pane}（下方）': 'Split #{pane} (below)',
  '窗口 {w} 新标签': 'New tab in window {w}',
  '新窗口': 'New window',
  '拆分 pane': 'Split pane',
  '新建标签页': 'New tab',
  '创建中…': 'Creating…',
  '创建': 'Create',
  '位置': 'Location',
  '启动': 'Start',
  '例如 cursor-agent、grok、npm run dev': 'e.g. cursor-agent, grok, npm run dev',
  '新 pane 会在 #{pane} 的会话目录里，带着它现在的全部上下文开一个新会话；原会话不受影响。':
    "The new pane opens in #{pane}'s session folder with a new session carrying all its current context; the original is untouched.",
  '目录': 'Folder',
  '搜索，或直接输入路径（~/ 开头也行）': 'Search, or type a path (~/ works too)',
  '没有匹配的目录，直接用输入的路径': 'No matching folder; the typed path will be used',

  // PaneActions.svelte
  '已在电脑上切到这个 pane': 'Switched to this pane on the computer',
  '#{pane} 已关闭': '#{pane} closed',
  '操作失败：{msg}': 'Action failed: {msg}',
  '窗口 {w} / 标签 {tab}': 'window {w} / tab {tab}',
  '新会话带着全部上下文，原会话不受影响': 'New session with all context; the original is untouched',
  '向右拆分': 'Split right',
  '向下拆分': 'Split down',
  '重命名标签页': 'Rename tab',
  '在电脑上切到这里': 'Switch to it on the computer',
  '再点一次确认关闭（里面的程序会被结束）': 'Tap again to close (running programs will be ended)',
  '关闭这个 pane': 'Close this pane',

  // PaneSheet.svelte
  '新建': 'New',
  '窗口 {w}': 'Window {w}',
  '＋ 标签页': '+ Tab',
  '标签 {tab}': 'Tab {tab}',
  '{n} 个 pane': '{n} panes',
  '有新内容': 'New output',
  '#{pane} 操作': '#{pane} actions',

  // KeyEditor.svelte
  '快捷键': 'Shortcut keys',
  '恢复默认': 'Reset to default',
  '图钉亮着的键放在第一行，其余收在「⋯」里。加一个宏：点一下就发出这段文字，比如 /compact、git status':
    'Pinned keys go in the first row; the rest are under "⋯". Add a macro: one tap sends the text, e.g. /compact, git status',
  '要发送的文字': 'Text to send',
  '按钮名': 'Label',
  '发送后按回车': 'Press Enter after',
  '添加': 'Add',
  '移出第一行': 'Remove from first row',
  '放到第一行': 'Pin to first row',
  '上移': 'Move up',
  '下移': 'Move down',
  '显示': 'Show',
  '隐藏': 'Hide',

  // NotifySheet.svelte
  '保存失败：{msg}': 'Save failed: {msg}',
  '这台设备的浏览器不支持网页推送（iOS 需要 16.4 以上）。': "This device's browser doesn't support web push (iOS needs 16.4 or later).",
  '先点 Safari 的「分享 → 添加到主屏幕」，再从主屏幕图标打开，才能开启通知。':
    'In Safari, tap "Share → Add to Home Screen", then open it from the Home Screen icon to enable notifications.',
  '通知权限被拒绝了。到 iPhone「设置 → 通知 → Panes」里打开后再回来。':
    'Notification permission was denied. Turn it on in iPhone "Settings → Notifications → Panes", then come back.',
  '已开启。某个 pane 出现选择器、权限确认或 y/n 提示时会推送；你正在手机上看的 pane、或你最近 2 分钟在用电脑时不推。同一个 pane 15 秒内只推一次。':
    "On. You'll get a push when a pane shows a picker, permission prompt or y/n question; not for the pane you're viewing on the phone, or if you used the computer in the last 2 minutes. At most once per pane every 15 seconds.",
  '开启后，任何 pane 在等你选择或确认时会推送到这台手机，点通知直接打开那个 pane。':
    'When on, any pane waiting for your choice or confirmation pushes to this phone; tap the notification to open that pane.',
  '通知已开启': 'Notifications on',
  '开启失败：{msg}': 'Enable failed: {msg}',
  '已发送，切到后台或锁屏看看': 'Sent; switch away or lock the screen to see it',
  '发送失败（{n} 个订阅失败）': 'Send failed ({n} subscriptions failed)',
  '发送失败：{msg}': 'Send failed: {msg}',
  '通知已关闭': 'Notifications off',
  'Claude / Codex 一轮做完也推送': 'Also push when a Claude / Codex turn finishes',
  '需要该会话启动时已加载 hook，旧会话重开后才生效': 'Needs the hook loaded at session start; reopen older sessions for it to apply',
  '开启通知': 'Enable notifications',
  '发一条测试': 'Send a test',
  '关闭通知': 'Turn off notifications',

  // Inbox.svelte
  '已在 Cursor 里点了「{label}」': 'Clicked "{label}" in Cursor',
  '没点成：{msg}': "Couldn't click: {msg}",
  '已回答 {name}：{choice}': 'Answered {name}: {choice}',
  '等你操作（{n}）': 'Waiting for you ({n})',
  '现在没有 pane 或 Cursor 会话在等你': 'No panes or Cursor sessions are waiting for you',
  'Cursor 会话': 'Cursor session',
  '在等你': 'Waiting for you',
  '没认出可点的选项，打开看看': 'No tappable options found; open it to check',

  // DraftBar.svelte
  '中断': 'Interrupt',
  '电脑输入框：': 'Computer input: ',
  '接过来改': 'Edit here',
  '提交': 'Submit',
  '改一改': 'Edit',

  // Reader.svelte
  '复制失败（需要 HTTPS）': 'Copy failed (HTTPS required)',
  '上一个': 'Previous',
  '下一个': 'Next',
  '已复制选中的文字': 'Selection copied',
  '已复制全部内容': 'All text copied',
  '复制链接': 'Copy link',

  // AgentFocusBar.svelte
  '正在看后台 agent「{name}」，现在发的消息会发给它，不是主会话':
    'Viewing background agent "{name}"; messages go to it, not the main session',
  '焦点在后台 agent 列表上，选中了「{name}」：这时回车会打开它、按 x 会停掉它':
    'Focus is on the background agent list with "{name}" selected: Enter opens it, x stops it',
  '焦点在后台 agent 列表上，打字和发送进不了输入框': "Focus is on the background agent list; typing and sending won't reach the input box",
  '没能自动回到主会话，打开终端视图看一眼': "Couldn't return to the main session automatically; check the terminal view",
  '处理中…': 'Working…',
  '回到输入框': 'Back to input',
  '回到主会话': 'Back to main',

  // KeyBar.svelte / Joystick.svelte
  '收起更多按键（长按编辑）': 'Hide more keys (long-press to edit)',
  '更多按键（长按编辑）': 'More keys (long-press to edit)',
  '方向摇杆：按住拖动': 'Arrow joystick: hold and drag',

  // RenameSheet.svelte
  '已重命名': 'Renamed',
  '重命名失败：{msg}': 'Rename failed: {msg}',
  '留空恢复默认标题': 'Leave empty to restore the default title',
} as Record<string, string>
