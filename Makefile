# Single entry point for humans, Claude, hooks and CI. Logic lives in scripts/.
SHELL := /bin/bash
PROFILE ?= 4g_typical
N ?= 4
DURATION ?= 60
.PHONY: diag bundle-size doctor install verify fmt lint dev dev-stop web-build web-test signaling-test protocol-check e2e e2e-ui screenshots quality quality-all tunnel deploy-staging

doctor:          ; @scripts/doctor.sh
install:         ; @pnpm install
verify:          ; @scripts/verify.sh $(AREAS)
lint:            ; @scripts/verify.sh --lint-only $(AREAS)
fmt:             ; @scripts/fmt.sh

dev:             ; @scripts/dev.sh start      # build web, run worker on :8787 in background, wait until healthy
dev-stop:        ; @scripts/dev.sh stop
web-build:       ; @pnpm --filter @clearcall/web build
web-test:        ; @scripts/verify.sh web
signaling-test:  ; @scripts/verify.sh signaling
protocol-check:  ; @scripts/verify.sh protocol web signaling

e2e:             ; @scripts/e2e.sh $(ARGS)     # e.g. make e2e ARGS="--project=chromium tests/two-party.spec.ts"
screenshots:     ; @scripts/e2e.sh --project=screens
diag:            ; @scripts/diag.sh N=$(N) DURATION=$(DURATION) $(ARGS)   # N-party headless call → debug bundle
bundle-size:     ; @scripts/bundle-size.sh
quality:         ; @scripts/quality.sh $(PROFILE)
quality-all:     ; @scripts/quality.sh all

tunnel:          ; @scripts/tunnel.sh          # public https URL to the local dev server for real-phone testing (asks owner)
deploy-staging:  ; @scripts/deploy.sh staging
