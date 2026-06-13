#!/usr/bin/env bash
# 安装/卸载 wc26-board 采集 daemon 的 launchd KeepAlive 服务。
# 模板来源: sui-research/bin/install-weekly-cron.sh(同机已验证的 launchd 模式)
#
#   bash bin/install-launchd.sh          # install + load
#   bash bin/install-launchd.sh remove   # unload + remove

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.xiaodi.wc26-board.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$ROOT/logs"
NODE_BIN="$HOME/.nvm/versions/node/v22.22.2/bin"

action="${1:-install}"

case "$action" in
  remove|uninstall)
    if [[ -f "$PLIST_PATH" ]]; then
      launchctl bootout "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm "$PLIST_PATH"
      echo "Uninstalled: $PLIST_PATH"
    else
      echo "Not installed."
    fi
    exit 0
    ;;
  install|"") ;;
  *) echo "usage: $0 [install|remove]"; exit 1 ;;
esac

mkdir -p "$LOG_DIR" "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}/node</string>
    <string>node_modules/.bin/tsx</string>
    <string>src/daemon.ts</string>
  </array>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daemon-err.log</string>

  <key>WorkingDirectory</key>
  <string>${ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${NODE_BIN}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
  launchctl load "$PLIST_PATH"

echo "Installed: $PLIST_PATH (KeepAlive daemon)"
echo "Logs:      tail -F ${LOG_DIR}/daemon.log"
echo "Stop:      bash $0 remove"
