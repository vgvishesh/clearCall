# Single entry point for humans, Claude, hooks and CI. Logic lives in scripts/.
SHELL := /bin/bash
PROFILE ?= 4g_typical
.PHONY: doctor verify fmt lint ios-build ios-test ios-run ios-gen android-build android-test android-run \
        signaling-dev signaling-test signaling-deploy-staging protocol-check e2e screenshots quality quality-all

doctor:            ; @scripts/doctor.sh
verify:            ; @scripts/verify.sh $(AREAS)
fmt:               ; @scripts/fmt.sh all
lint:              ; @scripts/verify.sh --lint-only $(AREAS)

ios-gen:           ; @scripts/ios.sh gen
ios-build:         ; @scripts/ios.sh build
ios-test:          ; @scripts/ios.sh test
ios-run:           ; @scripts/ios.sh run

android-build:     ; @scripts/android.sh build
android-test:      ; @scripts/android.sh test
android-run:       ; @scripts/android.sh run

signaling-dev:     ; @scripts/signaling.sh dev
signaling-test:    ; @scripts/signaling.sh test
signaling-deploy-staging: ; @scripts/signaling.sh deploy-staging

protocol-check:    ; @scripts/protocol-check.sh
e2e:               ; @scripts/e2e.sh $(FLOW)
screenshots:       ; @scripts/screenshot.sh both $(NAME)
quality:           ; @scripts/quality.sh $(PROFILE)
quality-all:       ; @scripts/quality.sh all
