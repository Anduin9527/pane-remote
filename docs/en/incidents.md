# Incident reports

[中文](../incidents.md) | English

pane-remote collects the problems it notices in one place, one entry per problem with a running count. When it matters it pushes to your phone and asks whether to fix it. Tap "Fix" and an agent works on it in the pane-remote repo and reports back.

Incidents live on the machine that runs the server (`<dataDir>/incidents.json`, at most 300) and are never uploaded anywhere.

## Who notices problems

pane-remote itself has no model. A program cannot judge whether a result "looks right", so detection is layered:

| source | what it catches |
|---|---|
| server | process-level exceptions; program errors in API handlers (`TypeError`, JSON parse failures, Python tracebacks; ordinary rejections like bad arguments don't count); push delivery failures; scan-loop errors (not "the Mac is asleep"); more than 8 reconnects of one pane in 5 minutes; a connection to the Mac that cannot be restored |
| phone | script errors, unhandled promises, a page that has not rendered after 6 s, send failures (network blips are common, so only by count) |
| Mac | unexpected MCP tool errors (not ordinary rejections like "no such pane"); failed "restart and load" |
| agent | agents with the plugin call `report_incident`: a call "succeeded" with the wrong result, a notification never reached the phone, you said pane-remote misbehaved. This is the part a program cannot judge |
| you | "Problems → Report a problem" on the phone, with the current pane and phone details attached |

Beyond the rules, three model-free generic techniques cover new features without new rules:

- **Error-level capture**: any `console.error(...)` on the server becomes an incident (network and Mac-asleep errors excluded). In new code, log failures with `console.error('module: what happened', err)`; the module name becomes the incident kind.
- **Canary every 10 minutes**: pane list, reading one pane, a smoke start of the MCP server (list tools only), which agents are installed, and the event channel (the Mac writes one event, the server must read it within 25 s). Skipped while the Mac is asleep. To cover a new feature, add a step to `canary()` in `server/server.mjs`.
- **Silent-catch audit**: `node scripts/silent-catch.mjs` lists places that swallow errors (`catch {}`, `.catch(() => {})`, `except: pass`), which nobody would ever notice failing. Mark the ones that are genuinely fine with `ignore: reason` on the same or previous line.

Deduplication uses a fingerprint: source + component + kind + the message normalized (numbers, IDs, build file names and home directories removed). A fixed problem that comes back is reopened and treated as severe.

## AI triage (optional, off by default)

Only **new** problems are triaged, once, with a cheap model: severity, whether it duplicates a known problem, whether to push, and a one-line summary (shown in pushes and the list). Severe ones push immediately; duplicates or low-noise ones wait until the 10th occurrence. Repeats, test incidents and your own reports are never triaged.

| agent | model | notes |
|---|---|---|
| Claude Code | Haiku | no tools, no hooks / MCP, a one-line system prompt; about 10k tokens and 5 s per call |
| Codex | the lightest model on your account (picked from `~/.codex/models_cache.json` by mini / luna / lite in the name) | read-only `codex exec` with hooks and MCP off; about 5k tokens, ~15 s |
| cursor-agent | Composer Fast (picked from `--list-models`) | ask mode (read-only), ~15 s |

- Turn it on in "Problems → settings → AI triage" on the phone, or set `"incidentTriage": true` in the config.
- "Auto" tries Claude → Codex → cursor-agent and moves on when an agent can't log in; you can also pin one.
- 20 calls per day by default; "Re-triage with AI" on the detail page.
- Uses your agent subscription, no separate API bill.

**Relay mode**: the server reaches the Mac over ssh, where the macOS keychain is locked, so Claude Code and cursor-agent logins stored there can't be read (Codex keeps its login in a file and works). To use them, run `claude setup-token` in a Mac terminal (or create an API key in Cursor), then `agent/pane-agent triage-token claude` (or `cursor`) in the pane-remote folder and paste it. The token goes to `~/.config/pane-remote/triage-env` (mode 600) and is never printed. Local mode doesn't need this.

## When it pushes

- Severe problems (process crash, program error, page stuck, regression after a fix): on the first occurrence.
- Everything else: at the 3rd / 10th / 50th / 200th occurrence.
- At most one push per problem per 30 minutes, and at most 8 per hour overall.
- Never for ignored, muted or in-progress problems, or for ones you reported yourself.

Tapping the push opens that problem. Pushes to iPhone home-screen web apps have no buttons, so fix / ignore are on the detail page.

## On the phone

- A red count in the top bar while problems are open. "Problems" is also in the ⋯ menu.
- The detail page shows the last 5 occurrences with their raw text and context, and the fix timeline.
- Actions: fix, fix in a new agent, ignore, mute this, resolved, reopen, cancel fix.

## Who fixes

Choose in the settings at the top right of "Problems":

| mode | what happens |
|---|---|
| **Auto** (default) | the bound session if there is one, otherwise a new agent |
| **Bound session** | tap "Use as fixer session" in an agent session's session sheet (matched by session ID, so it survives restarts). When it is idle the problem is sent into its pane; while it is working the problem waits in a queue; if it is not running, it is resumed in a new tab (context intact) |
| **New each time** | a new agent in the pane-remote repo, with the plugin, whose first message is the problem |

For new sessions: the same agent that reported the problem (and, for Claude, the reporter's account); otherwise Claude; falls back to whichever is installed. It can also be pinned to Claude Code / Codex / cursor-agent.

**When to bind**: best when problems are rare and you already have a session iterating on pane-remote. It has the context and fixes fast. With many problems, or when that session is very long, switch to "new each time" so the working session is not interrupted.

## What the fixing agent does

It receives `[pane-remote incident <id>] read <brief>…` and follows "Fixing a pane-remote incident" in the skill:

1. `incident_get` for the brief (raw occurrences, context, earlier fix attempts), then `incident_update(status="investigating")`.
2. Reproduce, fix and run the repo's own tests on a separate branch / git worktree, without touching the running checkout or your other work in progress.
3. **Ask before deploying, restarting services, pushing, opening a PR or merging** (via `ask_phone` when you are away), reporting `needs-confirm` while waiting.
4. Finish with `fixed` (branch or PR link, one or two sentences on the cause and how it was verified), `failed` or `wontfix`. You get a push for every step except `investigating`.

No runaway loops: problems reported by a fixing session are attached to the incident it is fixing, not opened or pushed separately (new fix sessions carry `PANE_REMOTE_INCIDENT`; bound sessions are matched by pane). One fix session per problem at a time.

The first agent started in the pane-remote repo makes Claude Code ask whether to trust the folder. That is your call. The fix timeline notes it and you get a push.

## API

| endpoint | purpose |
|---|---|
| `GET /api/incidents` | list, open count, fixer settings (`?summary=1` for just the count) |
| `GET /api/incidents/<id>` | detail |
| `POST /api/incidents/<id>/action {action}` | `fix` (optionally `mode: bound\|new`), `cancel-fix`, `ignore`, `resolve`, `reopen`, `mute`, `unmute` |
| `POST /api/incidents/report {title, detail?, ctx?}` | manual report |
| `GET\|POST /api/incidents/config` | `{fixer: auto\|bound\|new, agent: auto\|claude\|codex\|cursor-agent, bound}` |

Mac-side incidents reach the server through `events.jsonl` (`kind: "incident"`, `op: report|update`), the same file the hooks use. Bridge commands for fixing: `incident-brief`, `incident-repo`, `agent available`, `agent locate`.

## Testing

Incidents from panes in the `pane-remote-test` workspace are never pushed and are hidden from the default list (add `?test=1` to the API); their fix sessions open in that workspace too, so automated tests never disturb you.
