#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$REPO_DIR/bin/cybernetix"
BIN_DIR="$HOME/.local/bin"
BIN_DST="$BIN_DIR/cybernetix"

echo "[cnx] Installing Cybernetix from: $REPO_DIR"

# 1. Grant execute permission
chmod +x "$BIN_SRC"

# 2. Ensure ~/.local/bin exists
mkdir -p "$BIN_DIR"

# 3. Symlink into PATH
ln -sf "$BIN_SRC" "$BIN_DST"
echo "[cnx] Linked: $BIN_DST -> $BIN_SRC"

# 4. Ensure ~/.local/bin is in PATH (for current session and future shells)
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC=""
  case "${SHELL:-}" in
    */zsh)  SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
  esac

  if [[ -n "$SHELL_RC" ]]; then
    EXPORT_LINE='export PATH="$HOME/.local/bin:$PATH"'
    if ! grep -qF "$EXPORT_LINE" "$SHELL_RC" 2>/dev/null; then
      echo "" >> "$SHELL_RC"
      echo "# Added by cybernetix install" >> "$SHELL_RC"
      echo "$EXPORT_LINE" >> "$SHELL_RC"
      echo "[cnx] Added PATH entry to $SHELL_RC"
    fi
  fi

  # Also export for the remainder of this session
  export PATH="$BIN_DIR:$PATH"
fi

# 5. Run first-time setup
echo ""
cybernetix setup
