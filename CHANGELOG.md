# Changelog

All notable changes to pane-remote are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions were tagged retroactively. Version numbers start at 0.2.0 because
earlier work predates the public repository.

## [Unreleased]

## [0.9.1] - 2026-10-23

### Changed
- The Mac stays awake for 30 minutes after the phone was last used (was about 2½ minutes), so an agent keeps working and the phone can reconnect; `PANE_AWAKE_SECS` changes it.
- AI calls through Codex use their own `CODEX_HOME` without `~/.codex/AGENTS.md` (about 2.1K fewer input tokens per call); the login is shared and kept in sync. `createAi({ codexHome: false })` turns it off.

## [0.9.0] - 2026-10-23 — Versions and changelog

### Added
- A version number for the whole system (root `package.json`), shown under More → What's new together with this changelog; after an update the app says which version it moved to.
- `GET /api/version` and `GET /api/changelog`.
- Plugin API version (currently 0.2.0), separate from the system version. Plugins can declare `paneRemote.requires` (e.g. `">=0.2.0"`) in `whatevertools.json`; plugins that need a newer API are not loaded and are listed with the reason.

### Changed
- The plugin platform reports the system version (`platform.info()`, `utools.getAppVersion()`) instead of a fixed 0.1.0, and adds `api` to `platform.info()`.

## [0.8.0] - 2026-10-22 — Single-client takeover

### Added
- One client at a time: opening the app on a device takes over; the previous device is told which device took over and gets a "continue on this device" button. The holder survives a restart.
- The controlled computer itself can no longer open the app (detected from pane-host's interface addresses and the client IP, independent of Tailscale); `ALLOW_HOST_ACCESS=1` turns this off.
- Browser preview and the screen module share one live input bar: keys go through as you type, IME-safe composition, phone-side paste, sticky ⌘⌥⌃⇧ modifiers and a shortcut panel.
- Preview handles Delete / Home / End / PgUp / PgDn / Space and passes ⌘A/C/X/V/Z as edit commands on macOS.

### Changed
- Plugin pages shrink with the iOS keyboard so bottom inputs stay visible.

### Fixed
- Concurrent preview restarts no longer fail with "Screencast is already active"; preview handles phone messages one at a time.
- Unreachable preview URLs show the host name and are no longer reported as incidents.
- Relay-mode tunnel self-heal works without sudo (e.g. inside a systemd unit with `NoNewPrivileges`) and reports when it cannot find the stuck session.

## [0.7.0] - 2026-10-22 — Direct TLS listener

### Added
- Optional direct TLS listener on the tailnet address instead of `tailscale serve`, so a phone waking from sleep reconnects at once (off by default).
- Cursor 3.26 support: messages from the agent transcript and a changes view for new sessions.
- Running Cursor `/loop` loops are shown above the composer.

### Changed
- Phone telemetry is queued during outages and replayed later; error toasts and connection drops are reported.
- A wedged connection (relay reachable, no frames) reloads the page automatically.
- The sessions sheet is capped at 85% height and has a close button.
- Cursor per-turn fork asks for confirmation first.

### Fixed
- Per-turn fork for new Cursor sessions.
- A slow Cursor debug-port probe no longer sticks at "not started for remote control".
- The screen module survives a mousectl restart, and one undecodable JPEG no longer freezes the view.

## [0.6.0] - 2026-10-21 — Plugin platform and pane-host

### Added
- pane-host: a resident service on the computer that pushes transcripts and events over one connection, with fallback to the bridge path; installed and managed by `init`, `start` / `stop` / `restart`, `doctor` and `update`.
- Plugin platform (`plugins` module, on by default): plugin drawer, capsule header and quit confirmation; Preview, This Mac and Screen become built-in plugins.
- Plugins can use AI (local Claude Code, Codex and cursor-agent as providers), the clipboard, open URLs and read files.
- Model and effort switching per session, for terminal agents and Cursor sessions.
- Hash routes: notifications and the inbox open one exact address.

### Changed
- One session list for panes and Cursor sessions; agent panes open in the chat view, with "Raw screen" for the terminal.
- Code-split web app with lazy-loaded panels.

### Fixed
- Relay mode self-heals a stuck tunnel that holds the tunnel port.
- The GUI fallback never auto-starts an empty mux server.
- Event offsets stay monotonic across log truncation.

## [0.5.0] - 2026-10-20 — Agent tools and incident reports

### Added
- Agent tools: a pane-remote plugin (MCP server + skill) for Claude Code, Codex and cursor-agent — notify or ask on the phone, open pages in the preview, read or send to other panes.
- Restart an idle agent session in place with the plugin loaded, restoring its background work afterwards.
- Incident reports: problems are collected, pushed to the phone and can be handed to an agent to fix; optional AI triage and a 10-minute canary.
- Resume a recent Claude session from the new-tab page (#1, thanks @Anduin9527).

### Changed
- Sends survive a phone waking up (warm-up request, retries for up to 20 s).

### Fixed
- The preview Chrome no longer keeps running after the service goes away (#2, thanks @Anduin9527).
- Screen module right and middle click work on a phone.
- Push notifications get a valid Topic for every tag.
- Events resume from the saved offset after a restart.
- Agent exit works even when Claude's exit dialog is clipped.

## [0.4.0] - 2026-10-20 — Screen module

### Added
- Screen module (optional, macOS): view and control the Mac's screen or a single window from the phone.
- Window tools: close windows, quit apps, resize; summon menu-bar apps and Spotlight.
- Optional auto keyboard when a text field is focused; typing works on the lock screen.
- `mac` module (optional): performance overview and text-to-speech.
- `pane-remote update`: safe, incremental updates from the https origin with preview, confirmation and automatic rollback.

### Changed
- Whole displays are captured with ScreenCaptureKit, falling back to Screen Sharing.
- A remotely unlocked session is kept for an hour after the phone leaves.
- Chat view transfers less data (304 when unchanged, gzip otherwise).

## [0.3.0] - 2026-10-18 — Cursor IDE support

### Added
- Cursor IDE module: mirror the running Cursor's sessions on the phone.
- Cursor chat actions: fork (whole chat or from a turn), pin / unpin, archive; shared time and copy row for Claude and Cursor replies.
- Cursor usage for the current billing cycle at the top of the session list.
- Change a pane's width on the computer from the phone (fit phone / ±10 / equalize the tab).
- English UI, CLI and docs.

### Fixed
- Network blips: send retry with dedupe and a 5 s heartbeat.
- Fullscreen detection tolerates up to 8 extra rows of size drift.
- The preview file browser keeps its address across agent restarts and opens relative paths against the session folder.

## [0.2.0] - 2026-10-17 — First public release

### Added
- Phone PWA to control WezTerm panes and Claude Code / Codex sessions, with a chat view built from the transcript.
- Basic mode (single Mac + `tailscale serve`) with installer, `doctor` and uninstall.
- Optional modules: browser preview, open-URL handoff to the phone, and an SSH-relay mode.
- MIT license.

### Changed
- iPhone: safe areas respected everywhere, toasts clear the notch, solid status bar, new-version notice in the header.
