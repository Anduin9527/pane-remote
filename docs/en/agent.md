# Agent tools (the pane-remote plugin)

[中文](../agent.md) | English

Agents you start from the phone can load a pane-remote plugin. With it the agent knows it runs under a phone remote, and it can use the phone and this Mac in return: push you a notification when it is done, ask you on the phone when it is stuck, and open its dev server straight in your phone's preview.

Works with Claude Code CLI, Codex and cursor-agent. There is nothing to enable; `pane-remote init` sets it up.

## Loading it

- **New pane / fork**: below the launch options there is "Load pane-remote tools", on by default and remembered on the phone. It only applies to agent commands it recognises (`claude`, `claude-*`, `codex`, `cursor-agent`, and the commands in `claudeWrappers`); anything else runs unchanged.
- **A session that is already running**: "Restart and load tools" in the session sheet (tap twice to confirm). The same session restarts in place without losing context; see [Restart and load](#restart-and-load).

Each agent loads plugins differently; `agent/plugin/bin/with-tools` handles all of them:

| agent | how |
|---|---|
| Claude Code | `--plugin-dir agent/plugin` (MCP server + skill) |
| cursor-agent | `--plugin-dir agent/plugin --approve-mcps` |
| Codex | no plugin-dir flag: the MCP server via `-c mcp_servers.pane-remote.*`, and `developer_instructions` telling it to read the skill at the start |

The server types `~/.local/share/pane-remote/with-tools <original command>` into the pane. `init` / `refresh bridge-env` create that link (in relay mode the server does not know where the repo lives on the Mac).

## Tools for the agent (MCP)

| tool | what it does |
|---|---|
| `user_whereabouts` | where you probably are: whether the phone app was used in the last 2.5 minutes, how long the Mac keyboard/mouse has been idle |
| `notify_phone` | push a notification (one per pane per 20 s, 20 per hour overall) |
| `ask_phone` | ask you a question on the phone: a push plus a card at the top of the app; tap an option or type an answer. The agent waits until you answer or it times out (10 minutes by default, 30 at most) |
| `open_on_phone` | open a URL in the phone's preview (the preview browser runs on the Mac, so `localhost` works) |
| `mac_perf` / `mac_say` | the Mac's CPU, memory and top processes; speak a text with `say` |
| `mac_lock` | lock the screen (**asks you to confirm on the phone**) |
| `list_panes` / `read_pane` | list panes, read another pane's recent output |
| `send_to_pane` | type into another pane (**asks you to confirm on the phone**; never its own pane) |

The skill (`agent/plugin/skills/pane-remote/SKILL.md`) tells the agent when to use them: `ask_phone` when it is blocked on a decision and you are away from the Mac, no notifications for routine progress, replies that read well on a small screen, and never working around a declined confirmation.

Questions also show up in the inbox, where you can answer them directly. Tapping the push opens that pane.

**Note**: the phone confirmations protect against agent mistakes; they are not a security boundary. The agent can already run shell commands.

## Restart and load

Adds the plugin to a session that is already running without it. Only possible while the agent is idle (Claude Code from its own status file; Codex and cursor-agent from the screen); not while it is working or waiting for a confirmation.

What happens (all on the Mac, so it finishes even if the phone disconnects; progress shows in the sheet):

1. **Snapshot** (`~/.local/state/pane-remote/agent/snapshots/`, last 30 kept). For Claude Code: background commands, async subagents and Monitors started since this launch that have not finished, plus scheduled tasks and open tasks. For Codex and cursor-agent: just the session.
2. **The agent exits by itself**: `/exit` for Claude Code. With background work it asks what to do; pane-remote picks "Exit and stop tasks" (the snapshot is saved) and never "Move to background" (that would leave the session running in a background process, and resuming would give two processes writing one session). Ctrl-C for Codex and cursor-agent. It waits until the PID is really gone; if it is still there after 20 s it stops with an error and does not kill anything.
3. **Reopen in place**: in the session's directory, with the original launch flags (model, permission mode, …) plus the resume flag and the plugin. If it does not come up with the plugin, it falls back to a plain resume. When another Codex app holds the conversation, it forks a new session as Codex offers (the context is kept) and says so.
4. **Restore notes** (only when the snapshot has something): it sends `[pane-remote restore]` and the agent reads the snapshot. Read-only things (scheduled tasks, Monitors, background commands like log tails, watchers, dev servers) it recreates itself; commands that change state and subagents it lists and asks you about first; the task list survives with the session and is only checked.

Unsent text in the input box is cleared.

## How it fits together

```
agent (Claude Code / Codex / cursor-agent)
   │ stdio MCP
   ▼
agent/plugin/mcp.mjs (on the Mac, no dependencies)
   │ to the phone: a kind=agent event in ~/.local/state/pane-remote/events.jsonl (same file as the hooks)
   │ on the Mac: agent/bridge (list / text / send / mac-perf / mac-say)
   ▼
pane-remote server (server/server.mjs: onAgent pushes, hangs questions on the pane in /api/states)
   │ answers: POST /api/agent/answer → bridge agent-answer → answers/<id>.json → picked up by the MCP server
   ▼
phone (web/src/lib/components/AgentAsk.svelte, inbox, session sheet)
```

Restart and load: `POST /api/agent/restart {pane, confirm: true}` → bridge `agent restart` → `agent/pane-agent` (detached from the bridge; progress in `~/.local/state/pane-remote/agent/restart/<pane>.json`).

## Troubleshooting

- No "pane-remote tools" section in the session sheet: the pane's foreground program is not a recognised agent.
- Tools missing after loading: check `~/.local/state/pane-remote/agent/mcp.log` (one line per MCP start: which agent, which pane). `pane=null` means it could not tell which pane it is in, so its questions cannot reach the phone.
- `pane-remote doctor` says the agent tools are not linked: run `pane-remote refresh bridge-env`.
- Restart stuck at "exiting": look at the pane; the agent may be showing another confirmation. The snapshot is already saved.
