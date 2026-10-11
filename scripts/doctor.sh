#!/usr/bin/env bash
# Toolchain readiness for the web V1. Exit 1 if a blocker is missing.
source "$(dirname "$0")/lib.sh"; set +e
blockers=0
ok()   { printf '  \033[32m✓\033[0m %-20s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %-20s %s\n' "$1" "$2"; }
bad()  { printf '  \033[31m✗\033[0m %-20s %s\n' "$1" "$2"; blockers=$((blockers+1)); }
say "Core"
have node && ok node "$(node -v)" || bad node "install Node 22+"
have pnpm && ok pnpm "$(pnpm -v)" || bad pnpm "npm i -g pnpm"
[[ -d "$ROOT/node_modules" ]] && ok deps "installed" || warn deps "run: make install"
ls "$HOME/Library/Caches/ms-playwright" 2>/dev/null | grep -q chromium && ok "playwright browsers" "$(ls "$HOME/Library/Caches/ms-playwright" | grep -E '^(chromium|webkit|firefox)-' | tr '\n' ' ')" || bad "playwright browsers" "pnpm --filter @clearcall/e2e exec playwright install chromium webkit firefox"
say "Quality lab"
have ffmpeg && { ffmpeg -hide_banner -filters 2>/dev/null | grep -q libvmaf && ok ffmpeg "with libvmaf" || warn ffmpeg "no libvmaf (VMAF scoring disabled)"; } || warn ffmpeg "brew install ffmpeg"
have uv && ok uv "" || warn uv "brew install uv (audio scorers)"
have docker && docker info >/dev/null 2>&1 && ok docker "running" || warn docker "not running (netem network profiles need it: open -a Docker)"
say "Deploy / phone testing"
(cd "$ROOT/signaling" 2>/dev/null && pnpm exec wrangler whoami 2>/dev/null | grep -q "associated with") && ok "cloudflare login" "" || warn "cloudflare login" "owner: ! npx wrangler login (only needed to deploy)"
have cloudflared && ok cloudflared "" || warn cloudflared "brew install cloudflared (phone testing via make tunnel)"
echo; ((blockers==0)) && say "doctor: no blockers" || { printf '\033[31mdoctor: %d blocker(s)\033[0m\n' $blockers; exit 1; }
