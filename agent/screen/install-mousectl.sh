#!/bin/bash
# 编译鼠标助手 mousectl 并装成 LaunchAgent（登录会话里常驻，重启自动起）。看屏幕模块用，pane-remote enable screen 会调它。
# 第一次运行后系统会弹「辅助功能」授权：在 系统设置 → 隐私与安全性 → 辅助功能 里打开 mousectl；
# 按窗口看还要在「屏幕与系统录音」（屏幕录制）里打开它。
# 授权认的是签名：编译器默认的临时签名每次编译都变，授权就掉了。钥匙串里有自签名的代码签名证书
# （名字见 SIGN_ID）就用它签，之后重编授权不掉；没有就只在 mousectl 不存在时编译，免得白白掉授权。
#   --create-cert  先在登录钥匙串里建这张自签名证书（只用来给本机的 mousectl 签名，不会发给任何人）
set -euo pipefail
cd "$(dirname "$0")"
DIR=$(pwd)
LABEL=local.pane-remote.mousectl
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SIGN_ID="pane-remote local signing"
has_identity() { security find-identity -p codesigning 2>/dev/null | grep -q "\"$SIGN_ID\""; }

create_cert() {
  if has_identity; then echo "signing identity \"$SIGN_ID\" already exists"; return; fi
  local tmp
  tmp=$(mktemp -d)
  # 私钥只在这个临时目录里待几秒，导进钥匙串后连目录一起删掉
  trap 'rm -rf "$tmp"' EXIT
  ( umask 077
    cat > "$tmp/req.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $SIGN_ID
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/req.cnf" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1
    # pkcs12 的口令是一次性的随机数，只用来把文件导进钥匙串
    P12_PASS=$(openssl rand -hex 16)
    export P12_PASS
    # OpenSSL 3 默认的加密钥匙串认不了，要 -legacy；macOS 自带的 LibreSSL 没有这个参数，本来就是老格式
    openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$SIGN_ID" -out "$tmp/id.p12" -passout env:P12_PASS >/dev/null 2>&1 \
      || openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$SIGN_ID" -out "$tmp/id.p12" -passout env:P12_PASS >/dev/null 2>&1
    # -T：允许 codesign 用这把私钥（签名时不用每次点「允许」）
    security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -f pkcs12 -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
  )
  rm -rf "$tmp"
  trap - EXIT
  has_identity || { echo "failed to create the signing identity" >&2; exit 1; }
  echo "created signing identity \"$SIGN_ID\" in the login keychain"
  # 换了签名，之前给临时签名的授权不再算数：重编一次，之后重新授权一次就长期有效
  rm -f mousectl
}
[[ "${1:-}" == --create-cert ]] && create_cert

if has_identity; then
  swiftc -O -o mousectl mousectl.swift
  codesign -f -s "$SIGN_ID" -i "$LABEL" mousectl
elif [ ! -x mousectl ]; then
  swiftc -O -o mousectl mousectl.swift
fi
mkdir -p "$HOME/.cache/pane-remote"
chmod 700 "$HOME/.cache/pane-remote"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/mousectl</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.cache/pane-remote/mousectl.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# 刚 bootout 的旧实例可能还没退干净，bootstrap 会报错：等一下重试
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
(( ok )) || { echo "launchctl bootstrap failed for $LABEL" >&2; exit 1; }
echo "installed $LABEL"
