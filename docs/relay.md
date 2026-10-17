# 中转模式（增强版）

> 这部分是脚本加手动步骤，还没在一台全新的服务器上从零完整验证过。照着做遇到问题，`pane-remote doctor` 和服务器上的 `journalctl -u pane-remote` 是第一手线索。

## 什么时候用

基础版要求电脑本身跑 Tailscale。电脑跑不了 Tailscale 时，可以让一台在你 tailnet 里的服务器当中转：

```
手机 ──Tailscale──▶ 服务器（tailscale serve + pane-remote 服务）
                        │ SSH 反向隧道（电脑主动连出去，服务器上的 127.0.0.1:2222）
                        ▼
                    电脑上的 sshd ──▶ agent/bridge（forced command，只能执行白名单指令）
```

电脑不需要开放任何入站端口，也不需要跑 Tailscale；服务器在你的 tailnet 里。中转服务器要是你一个人专用的：服务器上的任何程序都能经隧道连到电脑的 sshd、也能调用服务。

用之前确认你所在组织的网络和安全规定允许这样做。

## 步骤

下面「电脑」= 装 WezTerm 的 Mac，「服务器」= 你的 Linux 云服务器（已经装好 Tailscale、Node.js 20+，并打开了 HTTPS Certificates）。

### 1. 电脑：基础安装，但不发布

```bash
./install.sh --skip-service --skip-serve --login <你的 Tailscale 登录名>
```

这一步装好 hook、写好 bridge 用的路径配置。电脑上不用跑服务。

### 2. 电脑：打开远程登录，并只允许密钥登录

系统设置 → 通用 → 共享 → 远程登录。反向隧道会把电脑的 sshd 暴露给中转服务器上的程序，所以务必关掉密码登录，只允许你自己的账号：

```
# /etc/ssh/sshd_config.d/pane-remote.conf（sudo 编辑），然后在共享设置里关掉再打开远程登录
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers <你的电脑用户名>
```

### 3. 两把 SSH 密钥

```bash
# 电脑 → 服务器：建反向隧道用
ssh-keygen -t ed25519 -f ~/.ssh/pane_remote_tunnel -N ""
# 服务器 → 电脑：调用 bridge 用（私钥要拷到服务器上）
ssh-keygen -t ed25519 -f ~/.ssh/pane_remote_bridge -N ""
```

- 把 `pane_remote_tunnel.pub` 加到**服务器**的 `~/.ssh/authorized_keys`（建议加上 `restrict,port-forwarding,permitlisten="127.0.0.1:2222"` 前缀，只允许建这一个隧道）
- 把下面命令打印的那一行加到**电脑**的 `~/.ssh/authorized_keys`：

  ```bash
  pane-remote relay authorized-key ~/.ssh/pane_remote_bridge.pub
  ```

  这一行限制了：只接受从本机（反向隧道）来的连接、只能执行 `agent/bridge`、不能转发端口或开终端。

### 4. 电脑：常驻反向隧道

```bash
ssh -i ~/.ssh/pane_remote_tunnel <用户>@<服务器>   # 先手动连一次，确认并记下服务器的 host key
pane-remote relay tunnel <用户>@<服务器>
```

断线会自动重连（launchd）。去掉：`pane-remote relay tunnel-off`。

### 5. 服务器：部署服务

```bash
# 在电脑上：把服务端拷过去（只需要 server/、public/、package*.json）
rsync -a server public package.json package-lock.json <用户>@<服务器>:pane-remote/
scp ~/.ssh/pane_remote_bridge <用户>@<服务器>:.ssh/
# 在服务器上：
cd ~/pane-remote && npm ci --omit=dev
chmod 600 ~/.ssh/pane_remote_bridge
ssh-keyscan -p 2222 127.0.0.1 >> ~/.ssh/known_hosts   # 反向隧道建好之后再跑，记下电脑的 host key
```

服务器上的配置 `~/.config/pane-remote/config.json`，用电脑上的命令生成后拷过去：

```bash
pane-remote relay server-config --mac-user <电脑上的用户名> --login <你的 Tailscale 登录名>
```

systemd 服务文件（`/etc/systemd/system/pane-remote.service`，把里面的用户名换成你的）：

```bash
pane-remote relay systemd
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now pane-remote
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

手机上打开服务器的 `https://<服务器名>.<tailnet>.ts.net/`。

## 升级

电脑上 `git pull`；服务器上重新 rsync `server/`、`public/` 后 `sudo systemctl restart pane-remote`。电脑和服务器的版本要一致（bridge 的指令要对得上）。
