#!/usr/bin/env bash
# Colophon native messaging host — macOS / Linux installer
# Run from the native-host/ directory:  bash install.sh
# Requires Python 3.8+ in PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.py"
MANIFEST_NAME="com.colophon.llamahost.json"

# ── Detect browser dirs ────────────────────────────────────────────────────────

if [[ "$OSTYPE" == "darwin"* ]]; then
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    CHROMIUM_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
else
    CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    CHROMIUM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
fi

# ── Check Python ───────────────────────────────────────────────────────────────

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found in PATH. Install Python 3.8+ and re-run."
    exit 1
fi
echo "Found: $(python3 --version)"

# ── Make host.py executable ────────────────────────────────────────────────────

chmod +x "$HOST_SCRIPT"

# ── Get extension ID ───────────────────────────────────────────────────────────

echo ""
echo "Open chrome://extensions, enable Developer mode, and copy your"
echo "Colophon extension ID (looks like: abcdefghijklmnopqrstuvwxyzabcdef)"
echo ""
read -rp "Paste extension ID: " EXTENSION_ID
EXTENSION_ID="${EXTENSION_ID// /}"

# ── Write manifest JSON ────────────────────────────────────────────────────────

MANIFEST_CONTENT=$(cat <<EOF
{
  "name": "com.colophon.llamahost",
  "description": "Colophon llamafile host",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

install_for_dir() {
    local dir="$1"
    mkdir -p "$dir"
    echo "$MANIFEST_CONTENT" > "$dir/$MANIFEST_NAME"
    echo "Installed: $dir/$MANIFEST_NAME"
}

install_for_dir "$CHROME_DIR"
[[ -d "$(dirname "$CHROMIUM_DIR")" ]] && install_for_dir "$CHROMIUM_DIR" || true

echo ""
echo "Installation complete. Reload the Colophon extension in chrome://extensions."
