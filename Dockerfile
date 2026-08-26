FROM node:22-bookworm-slim

ARG FNOX_VERSION=v1.25.1
ARG FNOX_SHA256=9bb4f563a65ba89e5a6759e95658eafbd1e32d8bd8cb1bf72fc5ff652566eaf5
ARG KUBECTL_VERSION=v1.34.5
ARG KUBECTL_SHA256=6a17dd8387783b3144a65535e38d02c351027e9718ea34a6c360476cb26d28bb
ARG MISE_VERSION=v2026.5.15
ARG MISE_SHA256=7d0460ccf507d468776bd8520002209cb3864e85c73c87bb0e9abad2276594c1
ARG OP_VERSION=v2.34.0
ARG OP_SHA256=198b05dcf9a0972778ce5a4e262c459979b0c837257b5da65e2fba6187734226
ARG OPENTOFU_VERSION=1.11.5
ARG OPENTOFU_SHA256=901121681e751574d739de5208cad059eddf9bd739b575745cf9e3c961b28a13
ARG PI_WEB_BUILD_ID=development
ARG PI_SYNC_COMMIT=667213eda54392b9ba546e5bd6dc896f384ec755

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
    PATH=/data/pi-ez-operator-home/.local/share/mise/shims:/usr/local/bin:$PATH \
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

RUN set -eux; \
    tmpdir="$(mktemp -d)"; \
    trap 'rm -rf "$tmpdir"' EXIT; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64-musl.tar.gz" \
      --output "$tmpdir/mise.tar.gz"; \
    printf '%s  %s\n' "$MISE_SHA256" "$tmpdir/mise.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file "$tmpdir/mise.tar.gz" --directory "$tmpdir"; \
    install --mode 0755 "$tmpdir/mise/bin/mise" /usr/local/bin/mise; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/fnox/releases/download/${FNOX_VERSION}/fnox-x86_64-unknown-linux-musl.tar.gz" \
      --output "$tmpdir/fnox.tar.gz"; \
    printf '%s  %s\n' "$FNOX_SHA256" "$tmpdir/fnox.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file "$tmpdir/fnox.tar.gz" --directory "$tmpdir"; \
    install --mode 0755 "$tmpdir/fnox" /usr/local/bin/fnox; \
    curl --fail --location --silent --show-error \
      "https://cache.agilebits.com/dist/1P/op2/pkg/${OP_VERSION}/op_linux_amd64_${OP_VERSION}.zip" \
      --output "$tmpdir/op.zip"; \
    printf '%s  %s\n' "$OP_SHA256" "$tmpdir/op.zip" | sha256sum --check --strict; \
    unzip -q "$tmpdir/op.zip" -d "$tmpdir/op"; \
    install --mode 0755 "$tmpdir/op/op" /usr/local/bin/op; \
    curl --fail --location --silent --show-error \
      "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/tofu_${OPENTOFU_VERSION}_linux_amd64.zip" \
      --output "$tmpdir/tofu.zip"; \
    printf '%s  %s\n' "$OPENTOFU_SHA256" "$tmpdir/tofu.zip" | sha256sum --check --strict; \
    unzip -q "$tmpdir/tofu.zip" -d "$tmpdir/tofu"; \
    install --mode 0755 "$tmpdir/tofu/tofu" /usr/local/bin/tofu; \
    curl --fail --location --silent --show-error \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      --output "$tmpdir/kubectl"; \
    printf '%s  %s\n' "$KUBECTL_SHA256" "$tmpdir/kubectl" | sha256sum --check --strict; \
    install --mode 0755 "$tmpdir/kubectl" /usr/local/bin/kubectl; \
    mise --version; fnox --version; op --version; tofu version; kubectl version --client=true

COPY package.json package-lock.json ./

# Pi is a production dependency: the real supervisor imports its SDK in-process.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# pi-sync is a private sibling repository and ships its reusable client from
# a nested package. The app repository carries a source snapshot stamped with
# PI_SYNC_COMMIT so CI never needs a cross-repository credential during a
# Docker build. Build that exact snapshot into the image.
COPY vendor/pi-sync /tmp/pi-sync
RUN set -eux; \
    test "$(cat /tmp/pi-sync/UPSTREAM_COMMIT)" = "$PI_SYNC_COMMIT"; \
    npm install --include=dev --ignore-scripts --no-audit --no-fund --package-lock=false --prefix /tmp/pi-sync; \
    npm run build --prefix /tmp/pi-sync; \
    mkdir -p node_modules/@bry-guy/pi-sync; \
    cp /tmp/pi-sync/package.json node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/dist node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/skills node_modules/@bry-guy/pi-sync/; \
    cp -a /tmp/pi-sync/extensions node_modules/@bry-guy/pi-sync/; \
    cp /tmp/pi-sync/README.md node_modules/@bry-guy/pi-sync/; \
    rm -rf /tmp/pi-sync

COPY server ./server
COPY public ./public

RUN mkdir -p /data/pi-ez-operator-home/.config/mise /data/pi-ez-operator-home/.local/share/mise /data/pi-ez-operator-home/.cache/mise \
    && printf '#!/bin/sh\nexec node /app/server/git-credential-helper.js\n' > /usr/local/bin/pi-ez-web-git-credential-helper \
    && chmod 0755 /usr/local/bin/pi-ez-web-git-credential-helper \
    && chown -R node:node /data

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
