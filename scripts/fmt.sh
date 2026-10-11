#!/usr/bin/env bash
# usage: fmt.sh  — format + safe-fix the whole workspace with Biome.
source "$(dirname "$0")/lib.sh"
[[ -x "$ROOT/node_modules/.bin/biome" ]] || fail "run pnpm install first"
cd "$ROOT" && node_modules/.bin/biome check --write .
