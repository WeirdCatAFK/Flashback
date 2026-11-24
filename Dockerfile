FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

# --omit=dev keeps the renderer out. Vite bundles every UI package, so UI packages belong in devDependencies.
RUN npm ci --omit=dev \
 && npm rebuild better-sqlite3

COPY src/ ./src/

# scripts/pure-token.js recovers a lost author token. Keep this COPY.
COPY scripts/ ./scripts/

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    USER_DATA_PATH=/data \
    FLASHBACK_PORT=50500 \
    FLASHBACK_HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY package.json ./

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 50500

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLASHBACK_PORT||50500)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run node directly. npm swallows SIGTERM, and only a clean stop checkpoints the WAL and flushes Seal.
CMD ["node", "--env-file-if-exists=/data/.env", "src/server/main.js"]
