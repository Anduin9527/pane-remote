---
name: pane-remote
description: You are running inside pane-remote, where the user drives this terminal from their phone. Read this at session start, and whenever you need the user while they may be away from the Mac, want to show them a page, act on another pane, or resume after a pane-remote restart.
---

# Running under pane-remote

The user controls this terminal (a WezTerm pane on their Mac) from a phone app called pane-remote. They may be at the Mac or away from it. The `pane-remote` MCP tools reach the phone and the Mac.

## Reaching the user
- `user_whereabouts` tells you whether the phone app was used in the last 2.5 minutes and how long the Mac has been idle. Check it before deciding how to reach the user.
- When you are **blocked on a decision** and the user is away (`atMac: false`), call `ask_phone` with 2–6 short options. Don't stall silently in the terminal. If it returns `answered: false`, take the safe default or stop and wait, and say so.
- `notify_phone` is for milestones: a long job finished, something broke, or you are waiting. Don't use it for routine progress. It is rate-limited.
- The user reads your replies on a small screen. Lead with the result, keep paragraphs short, and avoid wide tables when a list works.

## Showing things
- `open_on_phone` opens a URL in the phone's preview. The browser runs on this Mac, so `http://localhost:…` works. Use it after starting a dev server or writing an HTML report.

## This Mac and other panes
- `mac_perf` gives CPU, memory and top processes. `mac_say` speaks text aloud; use it only if the user asked for audible alerts.
- `list_panes` / `read_pane` let you look at other terminals, for example a dev server's log or another agent's progress.
- `send_to_pane` types into another pane and `mac_lock` locks the screen. Both ask the user to confirm on the phone and return without acting if they decline or don't answer. Never try to work around a declined confirmation.

## After a pane-remote restart
If the first message of the session starts with `[pane-remote restore]`, the session was restarted from the phone to load these tools. That message lists what was running before the restart. Follow its instructions:
- Re-create read-only items yourself: scheduled prompts (cron), monitors, and read-only background commands such as log tails, watchers and dev servers.
- For anything that changes state, list it with a one-line reason and get the user's approval first. This covers commands that write, deploy, push, delete or send, and also subagents. Use `ask_phone` with one option per item plus "全部重建" / "都不要" when the user is away; otherwise ask in the terminal.
- The task list survives restarts. Don't recreate tasks; check `TaskList`.
- Report briefly what you restored and what you skipped.
