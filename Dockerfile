# Breeze Overlay — container image
#
# Two stages. The builder holds the full workspace and every dev dependency
# (TypeScript, Vite, esbuild); the runtime holds compiled output and production
# dependencies only. Nothing that compiles code ships to air.
#
#   docker compose up -d --build
#
# Debian slim rather than Alpine on purpose. ssh2 (the SFTP drop source) and
# esbuild both resolve platform-specific binaries, and glibc is the variant
# those publish first and test most. The image is ~60 MB larger; a graphics
# server that starts is worth 60 MB. Alpine works if you want it — swap both
# FROM lines to node:24-alpine and add `apk add --no-cache libc6-compat`.

# ---------------------------------------------------------------- build stage
FROM node:24-slim AS builder

WORKDIR /app

# Corepack pins pnpm from the root package.json `packageManager` field, so the
# build cannot drift from the version the lockfile was written by.
RUN corepack enable

# Manifests first, source second. Dependencies change far less often than code,
# so this ordering keeps the install layer cached across ordinary edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/schema/package.json   packages/schema/
COPY packages/runtime/package.json  packages/runtime/
COPY apps/server/package.json       apps/server/
COPY apps/editor/package.json       apps/editor/

RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/     apps/
COPY scripts/  scripts/

# packages before apps: the server and editor both import the built
# @breeze/schema and @breeze/runtime dist output, not their sources.
RUN pnpm -r --filter=./packages/** build && \
    pnpm -r --filter=./apps/**     build

# -------------------------------------------------------------- runtime stage
FROM node:24-slim AS runtime

LABEL org.opencontainers.image.licenses="MPL-2.0"

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

# The workspace layout is reproduced rather than flattened. config.ts derives
# REPO_ROOT from the location of the server's own dist/, and finds examples/
# and apps/editor/dist relative to it — collapsing the tree would break the
# first-run seed and the editor mount without any error at build time.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/schema/package.json   packages/schema/
COPY packages/runtime/package.json  packages/runtime/
COPY apps/server/package.json       apps/server/
COPY apps/editor/package.json       apps/editor/

# `@breeze/server...` is the server plus its dependencies — so the editor's
# React/GSAP tree is skipped entirely. It was already bundled into the editor's
# dist by Vite; installing it again would add ~90 MB that nothing imports.
RUN --mount=type=cache,id=pnpm,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --filter @breeze/server...

COPY --from=builder /app/packages/schema/dist   packages/schema/dist
COPY --from=builder /app/packages/runtime/dist  packages/runtime/dist
COPY --from=builder /app/apps/server/dist       apps/server/dist
COPY --from=builder /app/apps/server/public     apps/server/public
COPY --from=builder /app/apps/editor/dist       apps/editor/dist

# Seed source for a first run against an empty data volume.
COPY examples/ examples/

# The named volume mounted here inherits this ownership the first time it is
# created. Without the chown it would be created root-owned and the server,
# running as uid 1000, could not write a project.
RUN mkdir -p /app/data/projects /app/data/assets && chown -R node:node /app/data

USER node

ENV BREEZE_PORT=7331 \
    BREEZE_HOST=0.0.0.0 \
    BREEZE_DATA_DIR=/app/data

# Informational only — the published port is set in docker-compose.yml.
EXPOSE 7331

# Reads the port from the environment so a remapped BREEZE_PORT does not leave
# the healthcheck probing 7331 and reporting a healthy server as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BREEZE_PORT||7331)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
