FROM node:22-bookworm-slim

ARG PI_WEB_BUILD_ID=development
ARG PI_SYNC_BASE_COMMIT=d5c46a99a250affe206a65c42db72072aac89da8

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real \
    HOME=/data/pi-ez-operator-home \
    XDG_CONFIG_HOME=/data/pi-ez-operator-home/.config \
    XDG_DATA_HOME=/data/pi-ez-operator-home/.local/share \
    XDG_CACHE_HOME=/data/pi-ez-operator-home/.cache \
    PI_WEB_BUILD_ID=$PI_WEB_BUILD_ID

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      openssl \
      python3 \
      rsync \
      tar \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Pi is a production dependency: the real supervisor imports its SDK in-process.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# pi-sync is a private sibling repository and ships its reusable client from
# a nested package. The app repository carries a source snapshot based on
# PI_SYNC_BASE_COMMIT. This checkout includes the web-host integration patch,
# so the marker verifies its upstream base rather than claiming an unmodified
# upstream package.
COPY vendor/pi-sync /tmp/pi-sync
RUN set -eux; \
    test "$(cat /tmp/pi-sync/UPSTREAM_COMMIT)" = "$PI_SYNC_BASE_COMMIT"; \
    npm install --include=dev --ignore-scripts --no-audit --no-fund --package-lock=false --prefix /tmp/pi-sync; \
    npm run build --prefix /tmp/pi-sync; \
    mkdir -p node_modules/@bry-guy/pi-sync; \
    cp /tmp/pi-sync/package.json node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/dist node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/skills node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/extensions node_modules/@bry-guy/pi-sync/; \
    cp /tmp/pi-sync/README.md node_modules/@bry-guy/pi-sync/; \
    rm -rf /tmp/pi-sync; \
    npm cache clean --force

COPY server ./server

COPY public ./public

RUN mkdir -p /data/pi-ez-operator-home \
    && printf '#!/bin/sh\nexec node /app/server/git-credential-helper.js "$@"\n' > /usr/local/bin/pi-ez-web-git-credential-helper \
    && chmod 0755 /usr/local/bin/pi-ez-web-git-credential-helper \
    && git config --system credential.https://github.com.helper /usr/local/bin/pi-ez-web-git-credential-helper \
    && chown -R node:node /data

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
