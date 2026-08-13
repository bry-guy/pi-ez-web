FROM node:22-bookworm-slim

ARG MISE_VERSION=v2026.5.15
ARG MISE_SHA256=7d0460ccf507d468776bd8520002209cb3864e85c73c87bb0e9abad2276594c1

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real \
    HOME=/data/pi-ez-operator-home \
    XDG_CONFIG_HOME=/data/pi-ez-operator-home/.config \
    XDG_DATA_HOME=/data/pi-ez-operator-home/.local/share \
    XDG_CACHE_HOME=/data/pi-ez-operator-home/.cache \
    MISE_DATA_DIR=/data/pi-ez-operator-home/.local/share/mise \
    MISE_CONFIG_DIR=/data/pi-ez-operator-home/.config/mise \
    MISE_CACHE_DIR=/data/pi-ez-operator-home/.cache/mise \
    PATH=/data/pi-ez-operator-home/.local/share/mise/shims:/usr/local/bin:$PATH

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

RUN set -eux; \
    tmpdir="$(mktemp -d)"; \
    trap 'rm -rf "$tmpdir"' EXIT; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64-musl.tar.gz" \
      --output "$tmpdir/mise.tar.gz"; \
    printf '%s  %s\n' "$MISE_SHA256" "$tmpdir/mise.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file "$tmpdir/mise.tar.gz" --directory "$tmpdir"; \
    install --mode 0755 "$tmpdir/mise/bin/mise" /usr/local/bin/mise; \
    mise --version

COPY package.json package-lock.json ./

# Pi is a production dependency: the real supervisor imports its SDK in-process.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data/pi-ez-operator-home/.config/mise /data/pi-ez-operator-home/.local/share/mise /data/pi-ez-operator-home/.cache/mise \
    && printf '#!/bin/sh\nexec node /app/server/git-credential-helper.js\n' > /usr/local/bin/pi-ez-web-git-credential-helper \
    && chmod 0755 /usr/local/bin/pi-ez-web-git-credential-helper \
    && chown -R node:node /data

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
