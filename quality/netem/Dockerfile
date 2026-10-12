# Lab peer: Chromium headless shell behind a Playwright run-server, shaped with tc netem (needs --cap-add NET_ADMIN).
# PW_VERSION must match quality/node_modules/@playwright/test (client and server protocol versions must agree).
#
# Base is plain ubuntu:24.04 + Node + `playwright install --with-deps --only-shell chromium` in ONE layer instead of
# mcr.microsoft.com/playwright: smaller (Chromium only, ~1 GB vs 2.5 GB), shares the ubuntu base layer, and avoids
# the multi-layer upstream image whose partially-extracted layer broke this host's overlay2 store (2026-10-12:
# "too many levels of symbolic links" on run). The lab always launches `headless: true`, i.e. the headless shell.
FROM ubuntu:24.04
ARG PW_VERSION=1.64.0
ARG NODE_VERSION=22.20.0
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH=/opt/node/bin:$PATH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl xz-utils iproute2 iputils-ping; \
    case "$(dpkg --print-architecture)" in amd64) a=x64;; arm64) a=arm64;; *) echo unsupported; exit 1;; esac; \
    mkdir -p /opt/node; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${a}.tar.xz" \
      | tar -xJ -C /opt/node --strip-components=1; \
    npm install -g "playwright@${PW_VERSION}"; \
    playwright install --with-deps --only-shell chromium; \
    npm cache clean --force; \
    apt-get purge -y --auto-remove xz-utils; \
    rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm
EXPOSE 3000
# --unsafe lets clients pass launch args; the lab also passes this command explicitly on `docker run`
# (src/netem.ts RUN_SERVER_CMD), so an image built before this line still works.
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0", "--unsafe"]
