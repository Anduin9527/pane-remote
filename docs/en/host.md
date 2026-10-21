# pane-host (resident service on the computer)

[中文](../host.md) | English

pane-host is a resident Node process on the computer (`host/main.mjs`). The server keeps **one** long-lived connection to it through the bridge's `host` command (a local child process in local mode, one ssh session in relay mode), speaking line-delimited JSON-RPC:

```
phone ──SSE / WS──▶ server/server.mjs ──server/host-client.mjs──▶ agent/bridge host ──▶ host/connect.mjs ──unix socket──▶ host/main.mjs
```

What it adds:

- **Pushed chat view**: pane-host watches the transcript file and pushes deltas only when it changes (`/api/transcript/stream`) instead of polling every few seconds; hook events are pushed too instead of polling `bridge events`.
- **Computer-side capabilities for plugins**: AI (the Claude Code / Codex / cursor-agent signed in on the computer), the computer's clipboard, opening URLs on the computer, read-only files; see [plugins.md](plugins.md).
- Far fewer ssh / bash / python processes in relay mode.

**Everything still works when pane-host is offline**: chat and events fall back to the old bridge path (polling); only the plugins' computer-side capabilities are unavailable (`EWTHOSTDOWN`).

## Install and manage

`pane-remote init` installs it as a LaunchAgent (`local.pane-remote.host`: starts at login, restarted if it crashes):

```bash
pane-remote init                 # install / update the LaunchAgent (--skip-host to skip)
pane-remote doctor               # the "pane-host is running" line
pane-remote restart              # restarts pane-host too
pane-remote uninstall            # stops and removes it
```

It also works without the LaunchAgent: on the first connection `host/connect.mjs` starts one on demand, which exits after 10 minutes without connections.

| File | Meaning |
|---|---|
| `~/.cache/pane-remote-host/host.sock` | unix socket (folder 0700, socket 0600: only you can connect) |
| `~/.cache/pane-remote-host/host.log` | log, a few lines on start and exit |
| `~/.config/pane-remote/host-env` | optional environment variables for pane-host (below) |

To turn it off: `"paneHost": false` in the config (the server stops connecting), or the server environment variable `PANE_HOST=0`.

## Proxy, Claude config folder (host-env)

A LaunchAgent process doesn't have your shell's environment. If AI needs a proxy, or Claude Code uses a different config folder, write `~/.config/pane-remote/host-env` (one `KEY=VALUE` per line, `#` comments) and run `pane-remote restart`:

```sh
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
CLAUDE_CONFIG_DIR=~/.claude-work
```

`chmod 600` is recommended (the log warns if it's wider); only variable names are logged, never values.

## AI providers

AI uses the command-line agents **already signed in** on the computer; pane-remote stores no API keys:

| Provider | Needs | Model list from |
|---|---|---|
| Claude Code | `claude` installed and signed in (`claude auth status`) | a few built-in common models |
| Codex | `codex` signed in (`codex login status`) | Codex's own model cache |
| cursor-agent | `cursor-agent` signed in (`cursor-agent status`) | `cursor-agent --list-models` |

With none of them, the model list in plugins is empty. Every call needs the plugin to hold the `ai` permission (asked on the phone) and uses that account's quota. AI child processes run in a temporary folder outside your home folder (so your global CLAUDE.md isn't pulled in) and don't touch your projects.

## Protocol and development

- Protocol: `host/protocol.mjs` (documented at the top): JSON-RPC 2.0 plus call / stream / sub extensions; topics carry sequence numbers so reconnects can replay.
- Methods: `ping`, `terminals.list` / `terminals.text` / `terminals.watch`, `transcript.get`, `ai.models` / `ai.complete`, `desktop.clipboard.*` / `desktop.openUrl`, `fs.*`; topics `events`, `transcript:<pane>:<count>`.
- Everything platform-specific is behind the Host interface (`host/hosts/interface.mjs`); only macOS is implemented. For other platforms see `host/hosts/README.md`.
- AI library details: `host/ai/README.md`.
- Tests: `npm test` (fake Host + real connect / host-client / agent/pane-event; no real terminal or agent involved).
- Manual check: `SSH_ORIGINAL_COMMAND=host agent/bridge`, type `{"jsonrpc":"2.0","id":1,"method":"ping"}` and Enter; one line should come back immediately.
