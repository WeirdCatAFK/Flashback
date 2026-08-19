# Flashback Server — headless host for one vault, several people.
#
# Two stages, for one reason: `better-sqlite3` is a native addon and needs python3/make/g++
# to compile, which have no business being in the image that runs on your network. The build
# stage compiles it against THIS image's Node, and the runtime stage takes only the result.
#
# Pin the Node minor deliberately. A native addon is compiled against a specific ABI, so a
# base image that silently moved to a new major would produce NODE_MODULE_VERSION errors at
# start — the same failure the desktop build hits when it mixes Electron and system Node.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests alone first so `npm ci` is cached against dependency changes rather than
# against every source edit.
COPY package.json package-lock.json ./

# --omit=dev drops electron, electron-builder, vite and eslint: ~none of it is reachable
# from src/server. `npm rebuild` is explicit rather than relying on the install's own build
# step, so a failure to compile the addon fails the image build loudly and here.
RUN npm ci --omit=dev \
 && npm rebuild better-sqlite3

COPY src/ ./src/


FROM node:22-bookworm-slim AS runtime

# The vault lives on a mounted volume, not in the image. `USER_DATA_PATH` is the one variable
# every path in the app resolves from — config.json, accounts.db and the vault directory are
# all under it (see access/primitives/config.js).
ENV NODE_ENV=production \
    USER_DATA_PATH=/data \
    FLASHBACK_PORT=50500 \
    FLASHBACK_HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package.json ./

# Run as the `node` user the base image already provides. Only /data is chown'd: it is the
# only thing written at runtime — the whole application state is files, and a read-only
# /data is a vault that cannot be studied, not a hardened deployment. /app stays root-owned
# and world-readable, which is what you want for code the process should not be able to
# rewrite.
#
# `chown -R` over /app would also be a genuine mistake rather than a style one: it rewrites
# every inode in node_modules, which makes Docker materialise a second full copy of that
# layer. Measured at 230s and several hundred MB before this was narrowed to /data.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 50500

# `GET /` is the readiness ping and is deliberately unauthenticated (see api.js), which is
# exactly what makes it usable here — a health check that needed a token would need the
# token distributed to the orchestrator. Uses Node's own fetch rather than adding curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLASHBACK_PORT||50500)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Not `npm start`: npm swallows SIGTERM, so the container would be killed after the grace
# period instead of shutting down cleanly — and a clean shutdown is what checkpoints the WAL
# and flushes Seal's pending commits (see src/server/main.js).
CMD ["node", "src/server/main.js"]
