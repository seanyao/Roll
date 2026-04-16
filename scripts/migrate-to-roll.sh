#!/usr/bin/env bash
# migrate-to-roll.sh — One-click migration to roll
# Handles any prior state: ~/.cybernetix/, ~/.wukong/, or both.
# Usage: bash scripts/migrate-to-roll.sh [--dry-run]
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

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

# Cross-platform in-place sed (macOS requires '' arg, Linux/GNU does not)
_sedi() { sed -i '' "$@" 2>/dev/null || sed -i "$@"; }

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}[dry-run]${NC} $*"
  else
    eval "$@"
  fi
}

confirm() {
  [[ "$DRY_RUN" == "true" ]] && { echo -e "  ${YELLOW}[dry-run]${NC} Would ask: $1 → assuming y"; return 0; }
  echo -n "  $1 [y/N] "
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

migrated=0; removed=0; skipped=0

echo ""
echo -e "${BOLD}Roll Migration Script${NC}"
echo -e "Migrates any prior state (${CYAN}~/.cybernetix/${NC} or ${CYAN}~/.wukong/${NC}) → ${GREEN}~/.roll/${NC}"
[[ "$DRY_RUN" == "true" ]] && warn "DRY-RUN mode — no changes will be made"
echo ""

# ─── Step 1: Detect source ───────────────────────────────────────────────────
step "Step 1: Detect migration source"

HAS_CNX=false; HAS_WK=false; SOURCE=""
[[ -d "$HOME/.cybernetix" ]] && HAS_CNX=true
[[ -d "$HOME/.wukong"     ]] && HAS_WK=true

if $HAS_WK && $HAS_CNX; then
  ok "Found both ~/.cybernetix/ and ~/.wukong/"
  info "Using ~/.wukong/ as source (more recent). ~/.cybernetix/ will be removed after."
  SOURCE="$HOME/.wukong"
  OLD_SOURCES=("$HOME/.wukong" "$HOME/.cybernetix")
  OLD_SKILL_PATTERNS=("wk-*" "cnx-*")
  OLD_BINS=("wukong" "cybernetix")
elif $HAS_WK; then
  ok "Found ~/.wukong/ — migrating from wukong"
  SOURCE="$HOME/.wukong"
  OLD_SOURCES=("$HOME/.wukong")
  OLD_SKILL_PATTERNS=("wk-*")
  OLD_BINS=("wukong")
elif $HAS_CNX; then
  ok "Found ~/.cybernetix/ — migrating directly from cybernetix"
  SOURCE="$HOME/.cybernetix"
  OLD_SOURCES=("$HOME/.cybernetix")
  OLD_SKILL_PATTERNS=("cnx-*")
  OLD_BINS=("cybernetix")
else
  warn "Neither ~/.wukong/ nor ~/.cybernetix/ found — nothing to migrate."
  info "Fresh install? Run: roll setup"
  exit 0
fi

# ─── Step 2: Copy source → ~/.roll/ ──────────────────────────────────────────
step "Step 2: Copy ${SOURCE/#$HOME/~} → ~/.roll/"
if [[ -d "$HOME/.roll" ]]; then
  warn "~/.roll/ already exists."
  if ! confirm "Overwrite ~/.roll/ with contents of ${SOURCE/#$HOME/~}?"; then
    info "Skipped copy — using existing ~/.roll/"
    skipped=$((skipped + 1))
  else
    run "rm -rf '$HOME/.roll'"
    run "cp -r '$SOURCE' '$HOME/.roll'"
    ok "Copied ${SOURCE/#$HOME/~} → ~/.roll/"
    migrated=$((migrated + 1))
  fi
else
  run "cp -r '$SOURCE' '$HOME/.roll'"
  ok "Copied ${SOURCE/#$HOME/~} → ~/.roll/"
  migrated=$((migrated + 1))
fi

# ─── Step 3: Update ~/.roll/config.yaml ──────────────────────────────────────
step "Step 3: Update ~/.roll/config.yaml"
ROLL_CONFIG="$HOME/.roll/config.yaml"
if [[ -f "$ROLL_CONFIG" ]] || [[ "$DRY_RUN" == "true" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}[dry-run]${NC} sed: update paths in $ROLL_CONFIG"
  else
    _sedi 's|\.cybernetix/|.roll/|g; s|\.wukong/|.roll/|g' "$ROLL_CONFIG" || true
    _sedi 's|cybernetix|roll|g; s|wukong|roll|g' "$ROLL_CONFIG" || true
  fi
  ok "Updated paths in ~/.roll/config.yaml"
  migrated=$((migrated + 1))
else
  warn "~/.roll/config.yaml not found — skipping"
  skipped=$((skipped + 1))
fi

# ─── Step 4: Update @include refs in ~/.claude/CLAUDE.md ─────────────────────
step "Step 4: Update @include references in ~/.claude/CLAUDE.md"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if [[ -f "$CLAUDE_MD" ]]; then
  changed=false
  if grep -q "@cnx\.md\|@wk\.md" "$CLAUDE_MD" 2>/dev/null; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo -e "  ${YELLOW}[dry-run]${NC} sed: update @include refs in $CLAUDE_MD"
    else
      _sedi 's|@cnx\.md|@roll.md|g; s|@wk\.md|@roll.md|g' "$CLAUDE_MD"
    fi
    ok "Updated @cnx.md / @wk.md → @roll.md in ~/.claude/CLAUDE.md"
    migrated=$((migrated + 1))
    changed=true
  fi
  # Also update the wk.md file itself if it exists
  WK_FILE="$HOME/.claude/wk.md"
  if [[ -f "$WK_FILE" ]] && [[ ! -f "$HOME/.claude/roll.md" ]]; then
    run "cp '$WK_FILE' '$HOME/.claude/roll.md'"
    ok "Copied ~/.claude/wk.md → ~/.claude/roll.md"
    migrated=$((migrated + 1))
  fi
  $changed || { info "No @cnx.md / @wk.md reference found — skipping"; skipped=$((skipped + 1)); }
else
  info "~/.claude/CLAUDE.md not found — skipping"
  skipped=$((skipped + 1))
fi

# ─── Step 5: Remove stale skill symlinks ─────────────────────────────────────
step "Step 5: Remove stale skill symlinks"
AI_DIRS=(~/.claude ~/.gemini ~/.kimi ~/.codex ~/.cursor)
for ai_dir in "${AI_DIRS[@]}"; do
  ai_dir=$(eval echo "$ai_dir")
  skills_dir="$ai_dir/skills"

  # Case A: whole-dir dangling symlink
  if [[ -L "$skills_dir" ]]; then
    real="$(cd "$skills_dir" 2>/dev/null && pwd -P || true)"
    if [[ -z "$real" ]]; then
      info "Removing dangling symlink ${skills_dir/#$HOME/~}"
      run "rm '$skills_dir'"
      removed=$((removed + 1))
    fi
    continue
  fi

  [[ -d "$skills_dir" ]] || continue

  # Case B: per-skill old symlinks
  for pattern in "${OLD_SKILL_PATTERNS[@]}"; do
    old_links=$(find "$skills_dir" -maxdepth 1 -type l -name "$pattern" 2>/dev/null || true)
    if [[ -n "$old_links" ]]; then
      count=$(echo "$old_links" | wc -l | tr -d ' ')
      info "Removing $count $pattern symlinks from ${skills_dir/#$HOME/~}/"
      while IFS= read -r link; do run "rm '$link'"; done <<< "$old_links"
      removed=$((removed + count))
    fi
  done
done
ok "Stale skill symlinks cleaned"

# ─── Step 6: Install roll binary ─────────────────────────────────────────────
step "Step 6: Install roll binary"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_SRC="$REPO_ROOT/bin/roll"
BIN_DST="$HOME/.local/bin/roll"

if [[ ! -f "$BIN_SRC" ]]; then
  warn "bin/roll not found at $BIN_SRC — skipping binary install"
  warn "Run: $REPO_ROOT/install.sh"
  skipped=$((skipped + 1))
else
  run "mkdir -p '$HOME/.local/bin'"
  run "chmod +x '$BIN_SRC'"
  run "ln -sf '$BIN_SRC' '$BIN_DST'"
  ok "Linked: ~/.local/bin/roll → $BIN_SRC"
  migrated=$((migrated + 1))
  [[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"
fi

# ─── Step 6b: Add ~/.local/bin to shell PATH (persistent) ────────────────────
step "Step 6b: Ensure ~/.local/bin is in PATH"
# Detect the shell rc file
SHELL_NAME="$(basename "${SHELL:-}")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="${BASH_ENV:-${HOME}/.bash_profile}" ;;
  *)    RC_FILE="$HOME/.profile" ;;
esac

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

if [[ -f "$RC_FILE" ]] && grep -qF '.local/bin' "$RC_FILE" 2>/dev/null; then
  ok "PATH already configured in $RC_FILE"
  skipped=$((skipped + 1))
else
  info "Adding $PATH_LINE to $RC_FILE"
  run "printf '\n# Added by migrate-to-roll\n%s\n' '$PATH_LINE' >> '$RC_FILE'"
  ok "Updated $RC_FILE — roll will be available in new terminals"
  migrated=$((migrated + 1))
fi

# Source for the current session
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"

# ─── Step 7: Install roll-* skill symlinks ────────────────────────────────────
step "Step 7: Install roll-* skill symlinks"
if command -v roll &>/dev/null; then
  run "roll sync"
  ok "roll-* skill symlinks installed"
else
  warn "'roll' not found in PATH."
  info "Run: source ~/${RC_FILE/#$HOME\//} && roll sync"
  skipped=$((skipped + 1))
fi

# ─── Step 8: Remove all old source directories ───────────────────────────────
step "Step 8: Remove old source directories"
for old_src in "${OLD_SOURCES[@]}"; do
  if [[ -d "$old_src" ]]; then
    if confirm "Remove ${old_src/#$HOME/~}?"; then
      run "rm -rf '$old_src'"
      ok "Removed ${old_src/#$HOME/~}"
      removed=$((removed + 1))
    else
      info "Kept ${old_src/#$HOME/~} — remove later: rm -rf ${old_src/#$HOME/~}"
      skipped=$((skipped + 1))
    fi
  fi
done

# ─── Step 9: Remove old binaries ─────────────────────────────────────────────
step "Step 9: Remove old binaries"
for old_bin_name in "${OLD_BINS[@]}"; do
  old_bin="$HOME/.local/bin/$old_bin_name"
  if [[ -L "$old_bin" ]] || [[ -f "$old_bin" ]]; then
    if confirm "Remove ~/.local/bin/$old_bin_name?"; then
      run "rm '$old_bin'"
      ok "Removed ~/.local/bin/$old_bin_name"
      removed=$((removed + 1))
    else
      info "Kept ~/.local/bin/$old_bin_name"
      skipped=$((skipped + 1))
    fi
  else
    info "~/.local/bin/$old_bin_name not found — skipping"
  fi
done

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Migration Summary${NC}"
echo -e "  ${GREEN}+${NC} Migrated: $migrated items"
echo -e "  ${RED}-${NC} Removed:  $removed items"
echo -e "  ${YELLOW}~${NC} Skipped:  $skipped items"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  warn "Dry-run complete — no changes made. Run without --dry-run to apply."
else
  ok "Migration complete!"
  echo ""
  info "Next steps:"
  echo "  1. Reload shell:  source ${RC_FILE/#$HOME/~}  (or open new terminal)"
  echo "  2. Verify:        roll status"
  echo ""
  info "Manual: update any project CLAUDE.md still referencing @cnx.md or @wk.md → @roll.md"
fi
