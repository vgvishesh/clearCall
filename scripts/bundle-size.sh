#!/usr/bin/env bash
# Gate: gzip size of the entry chunk + its static imports (what a first visit must download) ≤ BUDGET_KB.
source "$(dirname "$0")/lib.sh"
need_scaffold web/package.json "web app"
BUDGET_KB="${BUDGET_KB:-100}"
ensure_deps
run_logged web-build pnpm --filter @clearcall/web build >/dev/null
node - "$ROOT/web/dist" "$BUDGET_KB" <<'JS'
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const [dist, budget] = [process.argv[2], Number(process.argv[3])];
const manifest = JSON.parse(fs.readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));
const entry = Object.values(manifest).find((c) => c.isEntry);
const seen = new Set();
const walk = (key) => { if (seen.has(key)) return; seen.add(key); for (const i of manifest[key]?.imports ?? []) walk(i); };
walk(Object.keys(manifest).find((k) => manifest[k] === entry));
let total = 0;
for (const k of seen) {
  const c = manifest[k];
  for (const f of [c.file, ...(c.css ?? [])]) total += zlib.gzipSync(fs.readFileSync(path.join(dist, f))).length;
}
const kb = (total / 1024).toFixed(1);
if (total / 1024 > budget) { console.error(`  ✗ bundle-size: initial JS+CSS ${kb} KB gzip > ${budget} KB budget`); process.exit(1); }
console.log(`  ✓ bundle-size: initial JS+CSS ${kb} KB gzip (budget ${budget} KB)`);
JS
