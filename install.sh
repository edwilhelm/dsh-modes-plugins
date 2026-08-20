#!/usr/bin/env bash
#
# install.sh — Install the custom DeepSeek Harness modes, plugins, and skills
# from this repository into $DSH_HOME (.agent-presets and profiles/web).
#
# Usage:
#   ./install.sh              # install (prompts)
#   ./install.sh --dry-run    # preview only
#   ./install.sh --yes        # skip prompts
#   DSH_HOME=/custom ./install.sh   # override install root
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    --yes|-y)     YES=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRESETS_SRC="$REPO_ROOT/agent-presets"
WEB_SRC="$REPO_ROOT/web-profile"
PRESETS_DST="$DSH_HOME/.agent-presets"
WEB_DST="$DSH_HOME/profiles/web"
WEB_FILES=(cordis.yml cordis.patch.yml package.json pnpm-workspace.yaml)

log()  { printf '\033[36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$*"; }
skip() { printf '\033[90m    %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }

if [[ ! -d "$PRESETS_SRC" || ! -d "$WEB_SRC" ]]; then
  echo "error: run from the repository root ($REPO_ROOT)" >&2
  exit 1
fi

log "Installing to $DSH_HOME"

# ---- 1. backup existing files -------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$DSH_HOME/.dsh-modes-plugins-backup-$STAMP"
TO_BACKUP=()
for preset_dir in "$PRESETS_SRC"/*/; do
  name="$(basename "$preset_dir")"
  [[ -e "$PRESETS_DST/$name" ]] && TO_BACKUP+=("$PRESETS_DST/$name")
done
for f in "${WEB_FILES[@]}"; do
  [[ -e "$WEB_DST/$f" ]] && TO_BACKUP+=("$WEB_DST/$f")
done
[[ -e "$WEB_DST/plugins/subagent-acp" ]] && TO_BACKUP+=("$WEB_DST/plugins/subagent-acp")

if (( ${#TO_BACKUP[@]} > 0 )); then
  log "Backing up ${#TO_BACKUP[@]} existing item(s) -> $BACKUP_ROOT"
  for item in "${TO_BACKUP[@]}"; do
    rel="${item#"$DSH_HOME"/}"
    ok "backup $rel"
    if (( ! DRY_RUN )); then
      mkdir -p "$BACKUP_ROOT/$(dirname "$rel")"
      cp -R "$item" "$BACKUP_ROOT/$rel"
    fi
  done
else
  skip "Nothing to back up (clean install)"
fi

# ---- 2. copy agent presets ------------------------------------------------
log "Copying agent presets"
for preset_dir in "$PRESETS_SRC"/*/; do
  name="$(basename "$preset_dir")"
  ok "agent-presets/$name -> .agent-presets/$name"
  if (( ! DRY_RUN )); then
    mkdir -p "$PRESETS_DST"
    cp -R "$preset_dir" "$PRESETS_DST/$name"
  fi
done

# ---- 3. copy web profile ---------------------------------------------------
log "Copying web profile"
for f in "${WEB_FILES[@]}"; do
  ok "web-profile/$f -> profiles/web/$f"
  if (( ! DRY_RUN )); then
    mkdir -p "$WEB_DST"
    cp "$WEB_SRC/$f" "$WEB_DST/$f"
  fi
done
if [[ -d "$WEB_SRC/plugins/subagent-acp" ]]; then
  ok "web-profile/plugins/subagent-acp -> profiles/web/plugins/subagent-acp"
  if (( ! DRY_RUN )); then
    mkdir -p "$WEB_DST/plugins"
    cp -R "$WEB_SRC/plugins/subagent-acp" "$WEB_DST/plugins/"
  fi
fi

# ---- 4. opencode path fix-up ----------------------------------------------
PATCH_PATH="$WEB_DST/cordis.patch.yml"
if grep -q 'C:/PATH/TO/opencode\.exe' "$PATCH_PATH" 2>/dev/null; then
  log "opencode path"
  CANDIDATE="$(command -v opencode || true)"
  if (( YES )) || [[ -z "$CANDIDATE" ]]; then
    if (( YES )); then
      warn "Keeping placeholder C:/PATH/TO/opencode.exe — edit it in cordis.patch.yml yourself."
    else
      warn "Could not auto-detect opencode. Edit 'C:/PATH/TO/opencode.exe' in $PATCH_PATH yourself."
    fi
  else
    ok "Detected opencode at: $CANDIDATE"
    if (( ! DRY_RUN )); then
      sed -i.bak "s|C:/PATH/TO/opencode\.exe|${CANDIDATE//\//\\/}|g" "$PATCH_PATH"
      rm -f "$PATCH_PATH.bak"
    fi
  fi
fi

# ---- 5. summary ------------------------------------------------------------
log "Done"
ok "Presets installed: $(basename -a "$PRESETS_SRC"/*/ | tr '\n' ' ')"
ok "Web profile:       $WEB_DST"
(( ${#TO_BACKUP[@]} > 0 )) && ok "Backup:            $BACKUP_ROOT"
echo
printf '\033[36mNext steps:\033[0m\n'
echo '  1. Restart the harness (dsh web restart)'
echo '  2. Pick a mode: acp | autodiff | orchestrator'
if (( DRY_RUN )); then echo; warn 'DRY RUN — nothing was changed.'; fi
