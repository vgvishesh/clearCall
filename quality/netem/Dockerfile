# Lab peer: Chromium behind a Playwright run-server, shaped with tc netem (needs --cap-add NET_ADMIN).
# Version must match quality/node_modules/@playwright/test (client and server protocol versions must agree).
FROM mcr.microsoft.com/playwright:v1.64.0-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 iputils-ping \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g playwright@1.64.0 && npm cache clean --force
EXPOSE 3000
CMD ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
