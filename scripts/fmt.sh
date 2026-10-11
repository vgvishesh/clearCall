#!/usr/bin/env bash
# usage: fmt.sh all | fmt.sh <file>...   Formats in place. Silent when the formatter is missing.
source "$(dirname "$0")/lib.sh"
fmt_one() {
  case "$1" in
    *.swift) have swift-format && swift-format format -i "$1" 2>/dev/null || true ;;
    *.kt|*.kts) have ktlint && ktlint -F --relative "$1" >/dev/null 2>&1 || true ;;
    *.ts|*.js|*.json) [[ -x "$ROOT/signaling/node_modules/.bin/biome" && "$1" == "$ROOT/signaling/"* ]] && "$ROOT/signaling/node_modules/.bin/biome" format --write "$1" >/dev/null 2>&1 || true ;;
  esac
}
if [[ "${1:-all}" == all ]]; then
  git -C "$ROOT" ls-files -co --exclude-standard | grep -E '\.(swift|kt|kts|ts)$' | while read -r f; do fmt_one "$ROOT/$f"; done
else for f in "$@"; do fmt_one "$f"; done; fi
