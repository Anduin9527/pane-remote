# 这台电脑（mac 模块）

中文 | [English](en/mac.md)

在手机上看这台电脑的性能，或者让它用扬声器念一段话。全部用 macOS 自带的命令，不装额外的东西。只支持 macOS，默认关闭。

```bash
pane-remote enable mac
```

开启后手机顶栏会多一个仪表盘图标，点开是一个底部面板。

## 性能

- **CPU**：用户 / 系统占用（条形图）、核数、1 / 5 / 15 分钟负载
- **内存**：已用 / 总量，系统的内存压力（正常 / 偏紧 / 紧张，来自 `memory_pressure` 报的可用比例），压缩内存和交换区用量
- **占用最多的进程**：按 CPU 和按内存各 5 个，显示可执行文件名，属于某个 `.app` 的标上 app 名

只在面板开着、而且「性能」展开时才采，每 5 秒一次。CPU 要 `top` 采两次样才准（第一次是开机以来的平均），所以每次要 2 秒左右，第一次打开要等两三秒。

## 念出来

把一段话交给电脑上的 `say` 念出来（最多 2000 字），比如叫家里人、提醒自己。

- 有几句预设的话，点一下直接念
- **音色**：系统里装了的嗓音，中文排前面，同名的（普通版和增强版）只列一个；默认婷婷，没有就用第一个普通话嗓音
- **语速**：慢 / 正常 / 快
- **音量**：「不改」或 20%–100%，只在念的时候临时改，念完调回原来的音量（也能比原来小）
- **停**：打断正在念的，临时改过的音量也调回去

嗓音、语速、音量记在手机上。新念一句会打断上一句。

## 结构

```
手机（web/src/lib/mac/MacSheet.svelte）
   │ GET /api/mac/perf、GET /api/mac/voices、POST /api/mac/say、POST /api/mac/say-stop
   ▼
pane-remote 服务（server/mac.mjs，先查参数）
   │ bridge 的 mac-perf / mac-voices / mac-say <base64> / mac-say-stop
   ▼
agent/mac/perf.mjs（top、sysctl、memory_pressure、ps）、agent/mac/say.mjs（say、osascript 调音量）
```

## 安全

- 服务端先查一遍参数（文字长度、语速、音量范围），再把整个请求 base64 编码交给 bridge；bridge 只认这几个固定指令，base64 只许 `A-Za-z0-9+/=` 且有长度上限，不经过 shell
- `say.mjs` 把文字放在 `--` 后面直接作为参数交给 `/usr/bin/say`（不会被当成选项，也不经过 shell）；嗓音必须是 `say -v '?'` 列出来的，不在列表里就用默认的
- 「停」只结束自己记下的那个 `say` 进程（先确认进程名，免得进程号被别的程序复用）
- 性能只读系统自带命令的输出，不改任何东西

## 关掉

```bash
pane-remote disable mac
```

`pane-remote doctor` 会查要用的系统命令在不在。
