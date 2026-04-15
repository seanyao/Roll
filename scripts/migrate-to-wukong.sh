#!/usr/bin/env bash
# migrate-to-wukong.sh — One-click migration from cybernetix → wukong
# Usage: bash scripts/migrate-to-wukong.sh [--dry-run]
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# ─── Colors ──────────────────────────────────────────────────────────────────
if [[ -z "${NO_COLOR:-}" ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
  CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

info()  { echo -e "${CYAN}[migrate]${NC} $*"; }
ok()    { echo -e "${GREEN}[migrate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[migrate]${NC} $*"; }
err()   { echo -e "${RED}[migrate]${NC} $*" >&2; }
step()  { echo -e "\n${BOLD}── $* ──${NC}"; }

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}[dry-run]${NC} $*"
  else
    eval "$@"
  fi
}

confirm() {
  local prompt="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}[dry-run]${NC} Would ask: $prompt → assuming y"
    return 0
  fi
  echo -n "  $prompt [y/N] "
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# ─── Counters ────────────────────────────────────────────────────────────────
migrated=0; removed=0; skipped=0

echo ""
echo -e "${BOLD}Wukong Migration Script${NC}"
echo -e "Migrates ${CYAN}~/.cybernetix/${NC} → ${GREEN}~/.wukong/${NC}"
[[ "$DRY_RUN" == "true" ]] && warn "DRY-RUN mode — no changes will be made"
echo ""

# ─── Step 1: Check source exists ─────────────────────────────────────────────
step "Step 1: Check ~/.cybernetix/"
if [[ ! -d "$HOME/.cybernetix" ]]; then
  warn "~/.cybernetix/ not found — nothing to migrate."
  info "If wukong is already set up, run: wukong setup"
  exit 0
fi
ok "Found ~/.cybernetix/"

# ─── Step 2: Copy ~/.cybernetix → ~/.wukong ──────────────────────────────────
step "Step 2: Copy ~/.cybernetix/ → ~/.wukong/"
if [[ -d "$HOME/.wukong" ]]; then
  warn "~/.wukong/ already exists."
  if ! confirm "Overwrite ~/.wukong/ with contents of ~/.cybernetix/?"; then
    info "Skipped copy — using existing ~/.wukong/"
    skipped=$((skipped + 1))
  else
    run "rm -rf '$HOME/.wukong'"
    run "cp -r '$HOME/.cybernetix' '$HOME/.wukong'"
    ok "Copied ~/.cybernetix/ → ~/.wukong/"
    migrated=$((migrated + 1))
  fi
else
  run "cp -r '$HOME/.cybernetix' '$HOME/.wukong'"
  ok "Copied ~/.cybernetix/ → ~/.wukong/"
  migrated=$((migrated + 1))
fi

# ─── Step 3: Rewrite config.yaml paths ───────────────────────────────────────
step "Step 3: Update ~/.wukong/config.yaml"
WK_CONFIG="$HOME/.wukong/config.yaml"
if [[ -f "$WK_CONFIG" ]] || [[ "$DRY_RUN" == "true" ]]; then
  run "sed -i '' 's|\.cybernetix/|.wukong/|g' '$WK_CONFIG' 2>/dev/null || true"
  run "sed -i '' 's|cybernetix|wukong|g' '$WK_CONFIG' 2>/dev/null || true"
  ok "Updated ~/.wukong/config.yaml"
  migrated=$((migrated + 1))
else
  warn "~/.wukong/config.yaml not found — skipping"
fi

# ─── Step 4: Remove old cnx-* skill symlinks ─────────────────────────────────
step "Step 4: Remove stale cnx-* skill symlinks"
AI_DIRS=(~/.claude ~/.gemini ~/.kimi ~/.codex ~/.cursor)
for ai_dir in "${AI_DIRS[@]}"; do
  ai_dir=$(eval echo "$ai_dir")
  [[ -d "$ai_dir/skills" ]] || continue
  old_links=$(find "$ai_dir/skills" -maxdepth 1 -type l -name "cnx-*" 2>/dev/null || true)
  if [[ -n "$old_links" ]]; then
    count=$(echo "$old_links" | wc -l | tr -d ' ')
    info "Removing $count cnx-* symlinks from ${ai_dir/#$HOME/~}/skills/"
    while IFS= read -r link; do
      run "rm '$link'"
    done <<< "$old_links"
    removed=$((removed + count))
  fi
done
ok "Old cnx-* symlinks removed"

# ─── Step 5: Install wukong binary symlink ───────────────────────────────────
step "Step 5: Install wukong binary"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_SRC="$REPO_ROOT/bin/wukong"
BIN_DST="$HOME/.local/bin/wukong"

if [[ ! -f "$BIN_SRC" ]]; then
  warn "bin/wukong not found at $BIN_SRC — skipping binary install"
  warn "Run: bash $REPO_ROOT/install.sh"
  skipped=$((skipped + 1))
else
  run "mkdir -p '$HOME/.local/bin'"
  run "chmod +x '$BIN_SRC'"
  run "ln -sf '$BIN_SRC' '$BIN_DST'"
  ok "Linked: $BIN_DST → $BIN_SRC"
  migrated=$((migrated + 1))

  # Ensure ~/.local/bin is in PATH for this session
  if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
    export PATH="$HOME/.local/bin:$PATH"
    info "Added ~/.local/bin to PATH for this session"
  fi
fi

# ─── Step 6: Run wukong sync skills ──────────────────────────────────────────
step "Step 6: Install wk-* skill symlinks"
if command -v wukong &>/dev/null; then
  run "wukong sync skills"
  ok "wk-* skill symlinks installed"
else
  warn "'wukong' still not found in PATH."
  info "Add to your shell rc: export PATH=\"\$HOME/.local/bin:\$PATH\""
  info "Then run: wukong sync skills"
fi

# ─── Step 7: Remove ~/.cybernetix/ ───────────────────────────────────────────
step "Step 7: Remove ~/.cybernetix/"
if [[ -d "$HOME/.cybernetix" ]]; then
  if confirm "Remove ~/.cybernetix/ now? (migration is complete without it)"; then
    run "rm -rf '$HOME/.cybernetix'"
    ok "Removed ~/.cybernetix/"
    removed=$((removed + 1))
  else
    info "Kept ~/.cybernetix/ — you can remove it later: rm -rf ~/.cybernetix"
    skipped=$((skipped + 1))
  fi
fi

# ─── Step 8: Remove old cybernetix binary ────────────────────────────────────
step "Step 8: Remove old cybernetix binary"
OLD_BIN="$HOME/.local/bin/cybernetix"
if [[ -L "$OLD_BIN" ]] || [[ -f "$OLD_BIN" ]]; then
  if confirm "Remove $OLD_BIN?"; then
    run "rm '$OLD_BIN'"
    ok "Removed $OLD_BIN"
    removed=$((removed + 1))
  else
    info "Kept $OLD_BIN — you can remove it manually"
    skipped=$((skipped + 1))
  fi
else
  info "$OLD_BIN not found — skipping"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Migration Summary${NC}"
echo -e "  ${GREEN}+${NC} Migrated: $migrated items"
echo -e "  ${RED}-${NC} Removed:  $removed items"
echo -e "  ${YELLOW}~${NC} Skipped:  $skipped items"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  warn "Dry-run complete — no changes were made. Run without --dry-run to apply."
else
  ok "Migration complete!"
  echo ""
  info "Next: verify with  wukong status"
  echo ""
  info "Manual action needed:"
  echo "  • Update any existing project CLAUDE.md that references @cnx.md → @wk.md"
  echo "  • Reload your shell:  source ~/.zshrc  (or open a new terminal)"
fi
