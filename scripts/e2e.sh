#!/usr/bin/env bash
# Playwright E2E against the real worker + built assets. Extra args go to `playwright test`.
source "$(dirname "$0")/lib.sh"
need_scaffold e2e/package.json "E2E suite"
"$ROOT/scripts/dev.sh" start
cd "$ROOT/e2e" && run_logged e2e pnpm exec playwright test --reporter=line "$@"
echo "  report: e2e/playwright-report/index.html · screenshots: quality/reports/screens/"
