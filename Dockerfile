FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3141 \
    PI_WEB_MODE=real

WORKDIR /app
COPY package.json package-lock.json ./

# Pi is a peer dependency for local development, but is required at runtime.
RUN npm ci --omit=dev --ignore-scripts \
    && npm install --no-save --omit=dev --ignore-scripts @earendil-works/pi-coding-agent@0.84.1 \
    && npm cache clean --force

COPY server ./server
COPY public ./public

USER node
EXPOSE 3141
CMD ["node", "server/index.js"]
