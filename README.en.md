# pane-remote

[中文](README.md) | English

View and control the terminals in WezTerm on your Mac from your phone. Claude Code / Codex sessions get a dedicated chat view, push notifications and session management.
No third-party server is involved: phone and Mac talk over your own Tailscale network, and only your account can open it.

> The phone UI is currently Chinese only. This document quotes UI labels in Chinese with an English gloss.

## Features

**Basic** (available right after install)

- Live view of every WezTerm pane; type and send keys from the phone (key bar, arrow joystick, Ctrl / Shift / Option), swipe to scroll, tap
- New tab, split, close and rename panes; focus a pane on the Mac
- Claude Code / Codex:
  - Chat view (laid out from the session transcript, easier to read than the raw terminal)
  - **Fork session**: start a new session in a new pane with the full context of the current one (from the chat bar's 「分叉」 (Fork), the pane menu, or when splitting)
  - New session in the same directory, common slash commands
  - Scheduled-task panel inside a session: see schedules and last results, run now / restart / stop
  - Warns when focus has moved to the background agent list and returns to the input box in one tap
- Push notifications when a pane is waiting for your choice / confirmation or a turn finishes (not sent while you are at the Mac)
- To-do inbox: handle every pane that is waiting on you in one place
- Upload files to the Mac, long-press to open links in terminal output
- Automatic and manual reconnect

**Optional modules**

| Module | What it does | How to enable |
|---|---|---|
| Preview browser | View web pages reachable from the Mac (localhost, intranet) and files (folders, images, video, PDF, Markdown, code) on the phone, with a desktop mode (desktop UA, landscape full screen) | On by default when Chrome is installed; `pane-remote enable preview` |
| Open URLs on phone | When something on the Mac opens a link while you are using the phone, open it in the phone's preview instead | `pane-remote enable openUrl` |
| Cursor mapping | View and drive the Cursor IDE from the phone: sessions, messages, to-do / unread, command output, change diffs, built-in browser | `pane-remote enable cursor`, see [docs/en/cursor.md](docs/en/cursor.md) |
| Relay mode | When the Mac itself can't run Tailscale, relay through a server in your tailnet | See [docs/en/relay.md](docs/en/relay.md) |
| Persistent panes | Panes survive closing the WezTerm window and stay reachable from the phone | See [docs/en/advanced.md](docs/en/advanced.md) |

## Requirements

| | |
|---|---|
| Computer | macOS (Apple silicon or Intel) |
| Terminal | [WezTerm](https://wezfurlong.org/wezterm/), installed by the script; the phone shows WezTerm's panes |
| Network | [Tailscale](https://tailscale.com), with Mac and phone signed in to the same account. Enable **MagicDNS** and **HTTPS Certificates** for the tailnet (admin console → DNS). Self-hosted Headscale usually can't issue HTTPS certificates and won't work |
| Phone | iPhone (iOS 16.4+ for push) or Android, with the Tailscale app |
| Optional | Claude Code, Codex (chat view, fork, etc.); Chrome (preview browser); Cursor (Cursor module) |

The install script uses [Homebrew](https://brew.sh) for WezTerm and Tailscale. Node.js: the existing one (20+) is used; if there is none, the official build is downloaded from nodejs.org, checksum-verified, and used only by pane-remote.

## Install

```bash
git clone <repo-url> ~/pane-remote
cd ~/pane-remote
./install.sh
```

When it finishes, the terminal prints a `https://<mac-name>.<tailnet>.ts.net/` address (and a QR code if qrencode is installed). On the phone:

1. Open the Tailscale app and sign in with the same account as the Mac
2. Open that address in Safari
3. Share → Add to Home Screen, then open it from the home screen (push only works this way); turn on notifications from the bell in the top-right corner

**Restart any Claude / Codex sessions that were already open** so the new hooks take effect (needed for push and the chat view). For Codex, also confirm trust for the new hook inside Codex.

Common options:

```bash
./install.sh --yes                       # accept all defaults
./install.sh --chrome                    # no Chrome but want the preview browser: install Google Chrome via Homebrew
./install.sh --login you@example.com     # Tailscale account allowed to access (defaults to the Mac's account; required if the Mac is a tagged device)
./install.sh --no-brew                   # install WezTerm and Tailscale yourself, don't use Homebrew
./install.sh --lang en                   # command-line output in English (defaults to the system language)
```

The language choice is saved in the config, so later `pane-remote` commands use it too. Every `pane-remote` command also accepts `--lang en|zh`, and the `PANE_REMOTE_LANG=en|zh` environment variable overrides the saved setting.

## Everyday commands

```bash
pane-remote doctor            # self-check; every problem comes with a fix
pane-remote status            # is the service running
pane-remote restart | logs
pane-remote enable preview    # turn modules on / off: preview, openUrl, cursor
pane-remote disable openUrl
pane-remote init              # re-run after changing config, renaming the Mac or adding a Claude config dir (keeps existing config)
pane-remote uninstall         # stop the service, remove tailscale serve, restore hooks; --purge also deletes config and data
```

If the `pane-remote` command isn't on your PATH, use `~/pane-remote/bin/pane-remote`.

## Configuration

`~/.config/pane-remote/config.json` (created by init; run `pane-remote restart` after editing):

| Key | Meaning |
|---|---|
| `allowedLogins` | Tailscale login names allowed to access |
| `serveHosts` | Host names served by tailscale serve (filled in by init) |
| `port` | Local service port, default 8787 |
| `presets` | Launch commands offered when creating a pane, e.g. `{"label": "Claude Code", "command": "claude"}` |
| `claudeWrappers` | Claude config dir → launch command. With several `CLAUDE_CONFIG_DIR`s, forks must start with the same config dir |
| `modules` | Module switches |

## Security

- The service listens only on `127.0.0.1`; `tailscale serve` provides HTTPS to your tailnet. Nothing is exposed to the public internet
- Every request must carry the visitor identity injected by tailscale serve (`Tailscale-User-Login`); anyone not in `allowedLogins` is rejected. The Host must also be your Mac's ts.net host name, which stops web pages in a browser on the Mac from calling the API through localhost
- Every state-changing (non-GET) request must come from the app's own pages (Origin / Sec-Fetch-Site checked), which stops other sites from riding on your identity
- All terminal operations go through `agent/bridge`: it accepts a fixed set of commands, validates every argument and never runs arbitrary shell
- The preview file server listens only locally, uses a random token in its URL and can read only your home directory and `/tmp`; generated pages have a strict CSP, Markdown is sanitized with DOMPurify, script libraries are served locally, and raw files are served in a sandbox
- Markdown in the preview only shows local images; remote images (badges etc.) are not loaded, so opening a file never makes outbound requests
- **Assumption: you are the only user of this Mac.** The service trusts identity headers on local 127.0.0.1 requests, which other users or malware on the Mac could forge; the headless Chrome used for preview (and Cursor's debug port when the Cursor module is on) is protected only by listening locally. (Then again, anything that can run programs on your Mac could drive your terminal directly.) In relay mode the relay server must also be yours alone
- **This is remote control of your Mac's terminal from your phone**: don't add other people's accounts to `allowedLogins`, and never expose it publicly with `tailscale funnel`

## FAQ

**The address shows "forbidden"**: the Tailscale account on the phone isn't in `allowedLogins`, or you opened it by IP instead of the ts.net address.

**Chat view or push does nothing**: the session was started before the hooks were installed; restart it. Check the hook item in `pane-remote doctor`.

**Can't connect to WezTerm**: a WezTerm window must be open on the Mac; to work with windows closed, see the persistent setup in [docs/en/advanced.md](docs/en/advanced.md).

**tailscale serve fails**: HTTPS Certificates isn't enabled for the tailnet, or port 443 is taken by another service (init falls back to 8443 automatically).

## Layout

```
install.sh          one-step installer
bin/pane-remote     command entry (lib/cli.mjs)
server/             server (backend for the phone UI)
agent/              Mac-side scripts: bridge (the only entry to WezTerm), hooks, transcript parsing, preview browser, Cursor adapter
web/                phone UI source (Svelte); build output goes to public/
relay/              helper commands for relay mode
scripts/audit.mjs   pre-release audit: personal info, internal addresses and secrets
docs/               extra docs (Chinese); docs/en/ has the English versions
```

After changing the frontend, rebuild with `npm run build` (installs dev dependencies in web/).

## License

[MIT](LICENSE)
