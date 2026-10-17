# Relay mode (optional)

[中文](../relay.md) | English

> This part is scripts plus manual steps and hasn't been fully verified from scratch on a fresh server. If you run into trouble, `pane-remote doctor` and `journalctl -u pane-remote` on the server are the first places to look.

## When to use it

Basic mode needs Tailscale on the Mac itself. When the Mac can't run Tailscale, a server in your tailnet can act as a relay:

```
phone ──Tailscale──▶ server (tailscale serve + pane-remote service)
                        │ SSH reverse tunnel (the Mac connects out; 127.0.0.1:2222 on the server)
                        ▼
                    sshd on the Mac ──▶ agent/bridge (forced command, allow-listed commands only)
```

The Mac opens no inbound ports and doesn't run Tailscale; the server is in your tailnet. The relay server must be yours alone: any program on it can reach the Mac's sshd through the tunnel and call the service.

Before using it, make sure your organization's network and security policies allow it.

## Steps

Below, "Mac" is the Mac with WezTerm and "server" is your Linux cloud server (with Tailscale, Node.js 20+ and HTTPS Certificates already set up).

### 1. Mac: basic install without publishing

```bash
./install.sh --skip-service --skip-serve --login <your Tailscale login>
```

This installs the hooks and writes the paths the bridge uses. No service runs on the Mac.

### 2. Mac: enable Remote Login, keys only

System Settings → General → Sharing → Remote Login. The reverse tunnel exposes the Mac's sshd to programs on the relay server, so be sure to disable password login and allow only your own account:

```
# /etc/ssh/sshd_config.d/pane-remote.conf (edit with sudo), then turn Remote Login off and on again in Sharing
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers <your Mac user name>
```

### 3. Two SSH keys

```bash
# Mac → server: for the reverse tunnel
ssh-keygen -t ed25519 -f ~/.ssh/pane_remote_tunnel -N ""
# server → Mac: for calling the bridge (the private key gets copied to the server)
ssh-keygen -t ed25519 -f ~/.ssh/pane_remote_bridge -N ""
```

- Add `pane_remote_tunnel.pub` to the **server's** `~/.ssh/authorized_keys` (prefixing it with `restrict,port-forwarding,permitlisten="127.0.0.1:2222"` is recommended, so it can only open this one tunnel)
- Add the line printed by the following command to the **Mac's** `~/.ssh/authorized_keys`:

  ```bash
  pane-remote relay authorized-key ~/.ssh/pane_remote_bridge.pub
  ```

  That line only accepts connections from localhost (the reverse tunnel), can only run `agent/bridge`, and can't forward ports or open a terminal.

### 4. Mac: persistent reverse tunnel

```bash
ssh -i ~/.ssh/pane_remote_tunnel <user>@<server>   # connect once by hand to confirm and record the server's host key
pane-remote relay tunnel <user>@<server>
```

It reconnects automatically (launchd). To remove it: `pane-remote relay tunnel-off`.

### 5. Server: deploy the service

```bash
# On the Mac: copy the server over (only server/, public/, package*.json are needed)
rsync -a server public package.json package-lock.json <user>@<server>:pane-remote/
scp ~/.ssh/pane_remote_bridge <user>@<server>:.ssh/
# On the server:
cd ~/pane-remote && npm ci --omit=dev
chmod 600 ~/.ssh/pane_remote_bridge
ssh-keyscan -p 2222 127.0.0.1 >> ~/.ssh/known_hosts   # run after the reverse tunnel is up, to record the Mac's host key
```

Generate the server's config `~/.config/pane-remote/config.json` on the Mac and copy it over:

```bash
pane-remote relay server-config --mac-user <your Mac user name> --login <your Tailscale login>
```

The systemd unit (`/etc/systemd/system/pane-remote.service`; replace the user names in it with yours):

```bash
pane-remote relay systemd
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now pane-remote
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

On the phone, open the server's `https://<server-name>.<tailnet>.ts.net/`.

## Upgrading

`git pull` on the Mac; on the server, rsync `server/` and `public/` again and run `sudo systemctl restart pane-remote`. Mac and server must run the same version (bridge commands have to match).
