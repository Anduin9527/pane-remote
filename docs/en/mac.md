# This Mac (mac module)

[中文](../mac.md) | English

See this Mac's performance on your phone, or have it read some text aloud on its speakers. Everything uses commands that ship with macOS; nothing extra is installed. macOS only, off by default.

```bash
pane-remote enable mac
```

Once enabled, a gauge icon appears in the phone's top bar; it opens a bottom sheet.

## Performance

- **CPU**: user / system usage (bar), core count, 1 / 5 / 15 minute load
- **Memory**: used / total, the system's memory pressure (normal / tight / critical, from the free percentage `memory_pressure` reports), compressed memory and swap usage
- **Top processes**: the top 5 by CPU and by memory, showing the executable name and, when it belongs to an `.app`, the app name

It only samples while the sheet is open and the Performance section is expanded, every 5 seconds. `top` needs two samples for accurate CPU numbers (the first is the average since boot), so each read takes about 2 seconds and the first one takes a few seconds to appear.

## Speak

Hands some text to `say` on the Mac (up to 2000 characters), for example to call someone at home or remind yourself.

- A few preset phrases are spoken with one tap
- **Voice**: the voices installed on the system, Chinese first, duplicates (standard and enhanced) listed once; the default is Tingting, or the first Mandarin voice if it is missing
- **Speed**: slow / normal / fast
- **Volume**: "Keep" or 20%–100%, applied only while speaking and restored afterwards (it can also be lower than the current volume)
- **Stop**: interrupts the current speech and restores the volume if it was changed

Voice, speed and volume are remembered on the phone. Speaking again interrupts the previous phrase.

## Architecture

```
phone (web/src/lib/mac/MacSheet.svelte)
   │ GET /api/mac/perf, GET /api/mac/voices, POST /api/mac/say, POST /api/mac/say-stop
   ▼
pane-remote server (server/mac.mjs, validates first)
   │ bridge mac-perf / mac-voices / mac-say <base64> / mac-say-stop
   ▼
agent/mac/perf.mjs (top, sysctl, memory_pressure, ps), agent/mac/say.mjs (say, osascript for the volume)
```

## Security

- The server validates the request (text length, speed and volume ranges) and passes it to the bridge base64-encoded; the bridge accepts only these fixed commands, the base64 must be `A-Za-z0-9+/=` with a length limit, and no shell is involved
- `say.mjs` passes the text after `--` as a plain argument to `/usr/bin/say` (never read as an option, never through a shell); the voice must be one listed by `say -v '?'`, otherwise the default is used
- Stop only ends the `say` process it recorded (checking the process name first, in case the PID was reused)
- Performance only reads the output of built-in commands and changes nothing

## Turning it off

```bash
pane-remote disable mac
```

`pane-remote doctor` checks that the needed system commands are present.
