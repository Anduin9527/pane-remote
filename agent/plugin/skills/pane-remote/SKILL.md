---
name: pane-remote
description: You are running inside pane-remote, where the user drives this terminal from their phone. Read this at session start, and whenever you need the user while they may be away from the Mac, want to show them a page, act on another pane, resume after a pane-remote restart, report a pane-remote problem, or are asked to fix a pane-remote incident.
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

## Plugin tools and the shared todo list
- Tools named `plugin_<id>_<tool>` come from pane-remote plugins the user installed. The first call of a plugin's tools may wait for the user to allow it on the phone; if they decline, the call fails, so don't retry it.
- `plugin_todo_*` is the user's todo list, shared by every agent and shown on their phone. Add items the user should see or act on later (unfinished follow-ups, decisions waiting for them, known issues). Set `assignee` (agent / human / undecided) and `due` when you know them. Check `plugin_todo_list` first to avoid duplicates. It lists only your own items by default (added or claimed by this session, or under your working directory) and just counts the rest; other sessions' items are theirs, so pass `project: "all"` only when the user explicitly asks about all todos, and don't act on other sessions' items unless asked. When the user asks about "your tasks" without saying todo, they mean your own session task list.
- When you work on an item, call `plugin_todo_start` first (others then see it is taken; it refuses if another live session has it). Record progress with `plugin_todo_comment`; when you need the user's decision, use `plugin_todo_comment` with `needs_reply: true` (it is pushed to their phone, and their reply arrives in this session). Finish with `plugin_todo_done`.
- The user may send you a message starting with `[待办 <id>]` / `[todo <id>]` from the phone: that is a request to run or check that item; follow it and keep the item updated.
- Lines starting with `[pane-remote] Updates for this session` (in your context or appended to a tool result) tell you what the user did on the phone to items you created (done, edited, deleted, commented). Take them into account; don't redo finished items.

## Reporting problems with pane-remote
Use `report_incident` when pane-remote itself misbehaves. Examples: a pane-remote tool errors or returns something that cannot be right, a notification or question never reaches the phone, a restart leaves the session broken, or the user says the phone app did something wrong.
- Say what you called, with what arguments, what came back, and what you expected.
- Report pane-remote problems only. Problems in the user's own project are not incidents.
- Unexpected tool errors are already recorded automatically. Report the cases a program cannot judge: a call that "succeeded" but with the wrong result.

## Fixing a pane-remote incident
A message starting with `[pane-remote incident <id>]` asks you to fix a problem in pane-remote's own code.
1. Read the brief with `incident_get` (or the file named in the message). Then call `incident_update(status="investigating")`.
2. Work in the pane-remote repository on a separate branch or git worktree, for example `fix/incident-<id>`. Don't edit the checkout that is running. Don't touch the user's other work in progress.
3. Reproduce the problem, fix it, and verify the fix with the repo's own tests or checks. Follow the repo's instructions (CLAUDE.md / README / docs).
4. **Ask before anything outward-facing or live**: deploying, restarting services, pushing, opening a PR, merging. Use `ask_phone` when the user is away. Call `incident_update(status="needs-confirm")` while you wait.
5. Finish with `incident_update`:
   - `fixed`, with the branch or `pr_url` and one or two sentences on the cause and how you verified it;
   - otherwise `failed` / `wontfix` with the reason.
   
   If the repo has a remote you are allowed to push to, push the branch and open a PR after the user agrees. Otherwise leave the commit on the branch and say so.
6. If you were already in the middle of other work for the user when the message arrived, finish or park that first and tell the user you are switching to the incident.

## After a pane-remote restart
If the first message of the session starts with `[pane-remote restore]`, the session was restarted from the phone to load these tools. That message lists what was running before the restart. Follow its instructions:
- Re-create read-only items yourself: scheduled prompts (cron), monitors, and read-only background commands such as log tails, watchers and dev servers.
- For anything that changes state, list it with a one-line reason and get the user's approval first. This covers commands that write, deploy, push, delete or send, and also subagents. Use `ask_phone` with one option per item plus "全部重建" / "都不要" when the user is away; otherwise ask in the terminal.
- The task list survives restarts. Don't recreate tasks; check `TaskList`.
- Report briefly what you restored and what you skipped.
