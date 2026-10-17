# Cursor module

[中文](../cursor.md) | English

View and drive the [Cursor](https://cursor.com) IDE on your Mac from your phone: session list, messages, send / stop / new, to-do and unread, command output, project files, change diffs, and a live view of Cursor's built-in browser.

```bash
pane-remote enable cursor
```

Once enabled, a Cursor icon appears in the phone's top bar.

## How it works

Cursor is an Electron app. When it is started with `--remote-debugging-port=9333`, `agent/cursor-agent.mjs` on the Mac connects to Cursor's own page over the Chrome DevTools Protocol:

- **Session list and live status**: injects a read-only observer script that reads the sidebar and the current session (session id, title, status, text being generated, available buttons)
- **Full history**: opens Cursor's local database (`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`) read-only and reads messages per session; only primary-key lookups, no copying, no full scans
- **Actions**: focuses the matching session's input box in Cursor's page, types the text and clicks buttons; if the input box already has text (you were typing on the Mac), it refuses to write
- **Changes**: diffs the "original text before edits" that Cursor records against the current files on disk (read-only)
- **Built-in browser**: a page opened in Cursor's Browser panel is a separate web view; switch the preview source to 「Cursor 浏览器」 (Cursor browser) to view and control it

Only data is transferred, not video frames, so it stays responsive on poor networks. Memory use is capped (number of sessions, messages per session and their length), and nothing is cached to disk.

## Launching and restarting

- Cursor not running: tap 「启动 Cursor」 (Launch Cursor) on the phone (or just create a session / send a message). It starts with the debug port and shows progress
- Cursor opened the normal way: the phone shows 「重启并接入」 (Restart and attach). After you confirm, Cursor quits normally and reopens with the port, restoring its windows. Cursor asks first if anything is unsaved; running agents are interrupted
- To always have the port: launching once from the phone is enough. If you later open Cursor from the Dock (no port), the phone prompts you to restart and attach

## Notes

- **The debug port gives full control of Cursor** (and therefore indirectly of your Mac). It listens only on 127.0.0.1, but any program on the Mac can connect. Enable it only on a Mac that only you use
- This relies on Cursor's page structure and local data format, not an official API. After a Cursor update, `agent/cursor-agent.mjs` may need updating (the observer script is versioned and replaced automatically)
- If you operate Cursor on the Mac at the same time, sending from the phone can occasionally fail (e.g. the input box hasn't appeared yet right after a session switch). You'll be told to resend; it never sends to the wrong session
- When Cursor is set to require approval for commands, "waiting for you" detection relies on the sidebar status and button text on the page (Run / Accept / Skip, etc.). If it isn't recognized, open the session and the buttons are at the bottom of the chat page
