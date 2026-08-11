FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Pi is a production dependency: the real supervisor imports its SDK in-process.
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY server ./server
COPY public ./public

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
