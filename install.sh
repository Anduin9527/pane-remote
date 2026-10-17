#!/bin/bash
# pane-remote 一键安装：装依赖 → 准备 Node → 装 npm 依赖 → pane-remote init
#
#   ./install.sh            交互安装
#   ./install.sh --yes      全部用默认选项
#   ./install.sh --chrome   顺便用 Homebrew 装 Google Chrome（电脑上没装 Chrome、又想用预览浏览器时）
#   ./install.sh --no-brew  不用 Homebrew 装软件（自己装好 WezTerm、Tailscale）
#   其余参数原样交给 pane-remote init（比如 --login 你的Tailscale登录名、--port 8787）
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR=$(pwd)
YES=0; CHROME=0; BREW=1; INIT_ARGS=()
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1; INIT_ARGS+=(--yes) ;;
    --chrome) CHROME=1 ;;
    --no-brew) BREW=0 ;;
    *) INIT_ARGS+=("$a") ;;
  esac
done
say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
confirm() { [[ $YES == 1 ]] && return 0; read -r -p "$1 [Y/n] " a; [[ -z "$a" || "$a" =~ ^[Yy] ]]; }

[[ "$(uname)" == Darwin ]] || die "目前只支持 macOS"
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) die "不支持的 CPU：$(uname -m)" ;; esac

say "1. 软件依赖（WezTerm、Tailscale）"
if [[ $BREW == 1 ]]; then
  BREW_BIN=$(command -v brew || true)
  [[ -z "$BREW_BIN" && -x /opt/homebrew/bin/brew ]] && BREW_BIN=/opt/homebrew/bin/brew
  [[ -z "$BREW_BIN" && -x /usr/local/bin/brew ]] && BREW_BIN=/usr/local/bin/brew
  if [[ -z "$BREW_BIN" ]]; then
    die "没找到 Homebrew：先按 https://brew.sh 的说明装好，再跑一次（或者自己装好 WezTerm、Tailscale 后用 --no-brew）"
  fi
  if "$BREW_BIN" bundle check --file=Brewfile >/dev/null 2>&1; then
    ok "Brewfile 里的软件都装好了"
  elif confirm "  用 Homebrew 安装 Brewfile 里的软件（WezTerm、Tailscale、qrencode）？"; then
    "$BREW_BIN" bundle --file=Brewfile
  fi
fi

say "2. Node.js"
NODE=""
if command -v node >/dev/null 2>&1; then
  v=$(node -p 'process.versions.node.split(".")[0]')
  (( v >= 20 )) && NODE=$(command -v node) && ok "用电脑上已有的 Node $(node -v)"
fi
if [[ -z "$NODE" && -x runtime/node/bin/node ]]; then NODE=$APP_DIR/runtime/node/bin/node; ok "用之前下载的 Node $("$NODE" -v)"; fi
if [[ -z "$NODE" ]]; then
  # 从 nodejs.org 下载官方构建。版本和 SHA256 写死在这里（不信任同一台服务器上的校验文件），升级时一起改
  NODE_VERSION=22.23.3
  case "$ARCH" in
    arm64) NODE_SHA=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 ;;
    x64) NODE_SHA=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8 ;;
  esac
  file=node-v$NODE_VERSION-darwin-$ARCH.tar.gz
  tmp=$(mktemp -d)
  echo "  下载 $file …"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$file" -o "$tmp/$file" || die "下载 Node 失败"
  [[ "$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)" == "$NODE_SHA" ]] || die "Node 安装包校验不通过，已停止"
  rm -rf runtime/node && mkdir -p runtime/node
  tar -xzf "$tmp/$file" -C runtime/node --strip-components 1
  rm -rf "$tmp"
  NODE=$APP_DIR/runtime/node/bin/node
  ok "Node $("$NODE" -v) 装在 runtime/node（只给 pane-remote 用，不影响电脑上别的东西）"
fi
NPM="$(dirname "$NODE")/npm"
[[ -x "$NPM" ]] || NPM=$(command -v npm)

say "3. npm 依赖"
npm_config_update_notifier=false PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error
ok "服务端依赖、预览查看器用的脚本库（都装在本目录 node_modules）"

if [[ $CHROME == 1 ]]; then
  say "4. Google Chrome（预览浏览器用）"
  if [[ -d "/Applications/Google Chrome.app" ]]; then ok "已经装了"
  elif [[ -n "${BREW_BIN:-}" ]]; then "$BREW_BIN" install --cask google-chrome   # Homebrew 校验安装包哈希，Chrome 本身有 Google 签名和苹果公证
  else die "没有 Homebrew：去 https://www.google.com/chrome/ 下载安装 Chrome"
  fi
fi

say "配置并启动"
"$NODE" lib/cli.mjs init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"}

# 方便以后直接敲 pane-remote
if [[ -d "$HOME/.local/bin" && ":$PATH:" == *":$HOME/.local/bin:"* && ! -e "$HOME/.local/bin/pane-remote" ]]; then
  ln -s "$APP_DIR/bin/pane-remote" "$HOME/.local/bin/pane-remote"
  ok "以后可以直接用 pane-remote 命令（~/.local/bin/pane-remote）"
else
  echo "  以后的命令：$APP_DIR/bin/pane-remote <doctor|status|…>"
fi
