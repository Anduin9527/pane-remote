# Advanced configuration

[中文](../advanced.md) | English

## Persistent panes: keep working with the WezTerm window closed

By default panes live inside the WezTerm window: closing the window ends the programs in it, and the phone loses them.
Let WezTerm keep panes in a background mux server and treat the window as a viewer: programs keep running when the window closes, the phone can still view and control them, and reopening the window reattaches to the same panes.

1. Add to `~/.wezterm.lua` (or `~/.config/wezterm/wezterm.lua`):

   ```lua
   config.unix_domains = { { name = 'unix' } }
   -- connect to the background mux server on startup (starting it if needed)
   config.default_gui_startup_args = { 'connect', 'unix' }
   ```

2. Quit WezTerm completely and reopen it. Check that `~/.local/share/wezterm/sock` exists
3. Re-run `pane-remote init`: it detects the socket and writes it to the config, so the bridge talks to the mux server directly
4. Run `pane-remote doctor` and check that WezTerm is reachable

If you want the mux server running from login (without opening a window first), add a launchd agent running `wezterm-mux-server --daemonize`. This is optional.

Note: when the mux server restarts (e.g. after upgrading WezTerm), all its panes end, just like closing a terminal.

If you write your own launch script, start the mux server with `--daemonize` so it locks its pid file. Started in the foreground it does not, and any later `wezterm cli` call that fails to connect (a wrong socket path without `--no-auto-start`, say) spawns a second, empty server that takes over the `sock` path. The original server keeps running, but nothing can reach it, and the phone only shows an empty zsh.

## Multiple Claude Code accounts

If you separate accounts with `CLAUDE_CONFIG_DIR` (`~/.claude-work`, `~/.claude-personal`, ...), init installs hooks into every config dir
and records "config dir → launch command" in `claudeWrappers`, so forks and resumes start with the same account (otherwise the original session can't be found). The generated commands default to:

```json
"claudeWrappers": {
  ".claude": "claude",
  ".claude-work": "CLAUDE_CONFIG_DIR=\"$HOME/.claude-work\" claude"
}
```

If you normally launch through your own wrapper (e.g. `claude-work`), put that command there instead. Launch options for new panes live in `presets`.

## View only, no control

There is no read-only mode yet. Don't add anyone to `allowedLogins` who shouldn't be able to control your Mac.

## Running the service yourself behind your own reverse proxy

```bash
pane-remote init --skip-service --skip-serve
PANE_REMOTE_CONFIG=~/.config/pane-remote/config.json node server/server.mjs
```

The reverse proxy must, like tailscale serve, put the visitor's identity into the `Tailscale-User-Login` request header and must not let visitors forge that header.
Set `serveHosts` to the proxy's public host name. Don't do this without a trustworthy identity source.

## Skipping tailscale serve: when the phone can't reconnect after a night

`tailscale serve` handles connections inside tailscaled's own network stack. When a packet arrives for a connection it has already forgotten, it drops it silently instead of answering with a RST.
A phone waking up after a night keeps sending on its pre-sleep connections; every packet is dropped, requests hang, and reopening the app reuses the same dead connections, so everything looks disconnected and nothing reconnects.
On a Linux server, `journalctl -u tailscaled` shows `netstack: ... because the packet was not handled`.

Optional fix: let the server serve HTTPS on its tailnet address itself, using the kernel's TCP. Dead connections get a RST at once and the phone opens new ones.
Access stays tailnet-only. Identity comes from asking the local tailscaled who owns the peer IP (`whois`); any `Tailscale-User-Login` header sent by the client is discarded.

1. Get a certificate (HTTPS must be enabled in the Tailscale admin console):

   ```sh
   sudo tailscale cert --cert-file ~/tls.crt --key-file ~/tls.key <host>.<tailnet>.ts.net
   sudo chown "$USER" ~/tls.crt ~/tls.key
   ```

   Certificates expire after 90 days; re-run this weekly from cron / launchd / a systemd timer. The server re-reads the files every 6 hours, no restart needed.
2. Turn off serve on 443: `sudo tailscale serve --https=443 off`
3. Add to the config (`tailscale ip -4` prints the tailnet address):

   ```json
   "tls": { "listen": "100.x.y.z:443", "cert": "~/tls.crt", "key": "~/tls.key" }
   ```

   The environment variables `TLS_LISTEN` / `TLS_CERT` / `TLS_KEY` work too. Binding 443 needs privileges: on Linux add `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the systemd unit, or use a high port (and put it in the phone's URL).
4. Restart the server. `pane-remote tls on 100.x.y.z:443` in the log means it's active.

To go back: remove `tls`, run `tailscale serve --bg --https=443 http://127.0.0.1:8787` again, restart the server.
