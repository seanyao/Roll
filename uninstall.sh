#!/usr/bin/env bash
# uninstall.sh — Remove Roll from this machine
# Reverses install.sh: cleans AI tool configs, skill symlinks, ~/.roll/, and the binary.
# Usage: ./uninstall.sh [--dry-run]
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

info() { echo -e "${CYAN}[uninstall]${NC} $*"; }
ok()   { echo -e "${GREEN}[uninstall]${NC} $*"; }
warn() { echo -e "${YELLOW}[uninstall]${NC} $*"; }
step() { echo -e "\n${BOLD}── $* ──${NC}"; }

run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "  ${YELLOW}[dry-run]${NC} $*"
  else
    eval "$@"
  fi
}

# Cross-platform in-place sed
_sedi() { sed -i '' "$@" 2>/dev/null || sed -i "$@"; }

ROLL_HOME="${ROLL_HOME:-$HOME/.roll}"
ROLL_CONFIG="$ROLL_HOME/config.yaml"
BIN_DST="$HOME/.local/bin/roll"

echo ""
echo -e "${BOLD}Roll Uninstall${NC}"
[[ "$DRY_RUN" == "true" ]] && warn "DRY-RUN mode — no changes will be made"
echo ""

# ─── Collect AI tool directories from config (fall back to defaults) ─────────
_get_ai_dirs() {
  if [[ -f "$ROLL_CONFIG" ]]; then
    grep -E "^ai_[a-z]+:" "$ROLL_CONFIG" 2>/dev/null \
      | sed 's/^[^:]*:[[:space:]]*//' \
      | cut -d'|' -f1 \
      | sed "s|^~|$HOME|"
  else
    # Default fallback if config is missing
    echo "$HOME/.claude"
    echo "$HOME/.gemini"
    echo "$HOME/.kimi"
    echo "$HOME/.codex"
    echo "$HOME/.cursor"
    echo "$HOME/.openclaw/workspace"
  fi
}

# ─── Preview what will be removed ────────────────────────────────────────────
step "What will be removed"

[[ -d "$ROLL_HOME" ]]  && echo -e "  ${RED}✕${NC} ~/.roll/"
[[ -L "$BIN_DST" || -f "$BIN_DST" ]] && echo -e "  ${RED}✕${NC} ~/.local/bin/roll"

while IFS= read -r ai_dir; do
  [[ -d "$ai_dir" ]] || continue
  local_name="${ai_dir/#$HOME/~}"

  [[ -f "$ai_dir/roll.md" ]] && \
    echo -e "  ${RED}✕${NC} ${local_name}/roll.md"

  for cfg in CLAUDE.md GEMINI.md AGENTS.md .cursor-rules; do
    if [[ -f "$ai_dir/$cfg" ]] && grep -qF "@roll.md" "$ai_dir/$cfg" 2>/dev/null; then
      echo -e "  ${YELLOW}~${NC} ${local_name}/$cfg  (remove @roll.md line)"
    fi
  done

  if [[ -d "$ai_dir/skills" && ! -L "$ai_dir/skills" ]]; then
    count=$(find "$ai_dir/skills" -maxdepth 1 -type l -name "roll-*" 2>/dev/null | wc -l | tr -d ' ')
    [[ "$count" -gt 0 ]] && \
      echo -e "  ${RED}✕${NC} ${local_name}/skills/roll-* ($count symlinks)"
  fi
done < <(_get_ai_dirs)

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  warn "Dry-run complete — no changes made. Run without --dry-run to apply."
  exit 0
fi

echo -n "  Remove all of the above? [y/N] "
read -r answer
[[ "$answer" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

# ─── Step 1: Clean AI tool configs and skill symlinks ─────────────────────────
step "Step 1: Clean AI tool configs and skill symlinks"

while IFS= read -r ai_dir; do
  [[ -d "$ai_dir" ]] || continue
  local_name="${ai_dir/#$HOME/~}"

  # Remove roll.md
  if [[ -f "$ai_dir/roll.md" ]]; then
    run "rm '$ai_dir/roll.md'"
    ok "Removed: ${local_name}/roll.md"
  fi

  # Remove @roll.md line from config files
  for cfg in CLAUDE.md GEMINI.md AGENTS.md .cursor-rules; do
    if [[ -f "$ai_dir/$cfg" ]] && grep -qF "@roll.md" "$ai_dir/$cfg" 2>/dev/null; then
      run "_sedi '/^@roll\.md$/d; /^[[:space:]]*$/{ N; /^\n$/d; }' '$ai_dir/$cfg'"
      ok "Cleaned @roll.md from: ${local_name}/$cfg"
    fi
  done

  # Remove roll-* skill symlinks
  if [[ -d "$ai_dir/skills" && ! -L "$ai_dir/skills" ]]; then
    while IFS= read -r link; do
      run "rm '$link'"
    done < <(find "$ai_dir/skills" -maxdepth 1 -type l -name "roll-*" 2>/dev/null || true)
    count=$(find "$ai_dir/skills" -maxdepth 1 -type l -name "roll-*" 2>/dev/null | wc -l | tr -d ' ')
    [[ "$count" -gt 0 ]] && ok "Removed roll-* skill symlinks from: ${local_name}/skills/"
  fi
done < <(_get_ai_dirs)

# ─── Step 2: Remove ~/.roll/ ──────────────────────────────────────────────────
step "Step 2: Remove ~/.roll/"

if [[ -d "$ROLL_HOME" ]]; then
  run "rm -rf '$ROLL_HOME'"
  ok "Removed: ~/.roll/"
else
  info "~/.roll/ not found — skipping"
fi

# ─── Step 3: Remove binary ────────────────────────────────────────────────────
step "Step 3: Remove binary"

if [[ -L "$BIN_DST" || -f "$BIN_DST" ]]; then
  run "rm '$BIN_DST'"
  ok "Removed: ~/.local/bin/roll"
else
  info "~/.local/bin/roll not found — skipping"
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
ok "Roll has been uninstalled."
echo ""
info "Note: PATH entry in your shell rc file was not removed."
info "If you added 'export PATH=\"\$HOME/.local/bin:\$PATH\"', remove it manually if no longer needed."
echo ""
