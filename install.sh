#!/bin/bash
# Installs tmux-phone as a launchd service on this Mac and exposes it on your tailnet.
# Usage: ./install.sh <your Tailscale login email>      Safe to re-run; it replaces the previous install.
set -euo pipefail

LOGIN="${1:-}"
if [[ -z "$LOGIN" ]]; then
  echo "usage: ./install.sh <your Tailscale login email>   (the account shown in the Tailscale app)" >&2
  exit 1
fi

LABEL="com.tmux-phone"
PORT=8766
DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$HOME/.local/state/tmux-phone"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PYTHON=/usr/bin/python3
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
BREW_BIN="$(brew --prefix 2>/dev/null || true)/bin"  # /opt/homebrew on Apple Silicon, /usr/local on Intel

fail() { echo "✗ $1" >&2; exit 1; }
ok() { echo "✓ $1"; }

[[ -x "$PYTHON" ]] || fail "$PYTHON not found. Run: xcode-select --install"
[[ -x "$TAILSCALE" ]] || fail "Tailscale not found. Install the Tailscale app and sign in."
[[ -x "$BREW_BIN/tmux" ]] || fail "tmux not found in $BREW_BIN. Run: brew install tmux"
[[ -x "$BREW_BIN/ttyd" ]] || fail "ttyd not found in $BREW_BIN. Run: brew install ttyd"
[[ -x "$BREW_BIN/whisper-server" ]] || fail "whisper-server not found in $BREW_BIN. Run: brew install whisper-cpp"
[[ -x "$BREW_BIN/ffmpeg" ]] || fail "ffmpeg not found in $BREW_BIN. Run: brew install ffmpeg"
MODEL="$STATE/models/ggml-large-v3-turbo-q5_0.bin"
if [[ ! -f "$MODEL" ]]; then
  echo "Downloading the speech model (574 MB) to $MODEL"
  mkdir -p "$(dirname "$MODEL")"
  curl -fL -o "$MODEL.part" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
  mv "$MODEL.part" "$MODEL"
fi

HOST="$("$TAILSCALE" status --json 2>/dev/null | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')" \
  || fail "Tailscale is not signed in. Open the Tailscale app, sign in, and re-run."
ORIGIN="https://$HOST"
ok "Tailscale is up; this Mac is $HOST"

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PYTHON</string><string>$DIR/server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$STATE/server.log</string>
  <key>StandardErrorPath</key><string>$STATE/server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TMUX_PHONE_ORIGIN</key><string>$ORIGIN</string>
    <key>TMUX_PHONE_LOGIN</key><string>$LOGIN</string>
    <key>PATH</key><string>$BREW_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
  </dict>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null || fail "generated plist is invalid: $PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
ok "launchd service $LABEL installed (starts at login, restarts if it crashes)"

for _ in $(seq 1 20); do
  # The server refuses requests without a Tailscale identity, so 403 here means it is up.
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" == "403" ]] && break
  sleep 0.5
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" == "403" ]] \
  || fail "server did not start; see $STATE/server.log"
ok "server is listening on 127.0.0.1:$PORT (local only)"

# If HTTPS is off for the tailnet, this prints a link to turn it on and waits until you do.
"$TAILSCALE" serve --bg --https=443 "$PORT"
ok "tailscale serve: $ORIGIN → 127.0.0.1:$PORT (tailnet only, not the internet)"

# whisper-server takes a few seconds to load the model after a restart.
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:8767/" && break; sleep 0.5; done
"$PYTHON" "$DIR/smoke_test.py" "$ORIGIN" || fail "smoke test failed. If every check got 403, '$LOGIN' is not the login Tailscale reports for you."

echo
echo "Open on your phone, then Share → Add to Home Screen: $ORIGIN"
