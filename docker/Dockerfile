ARG NODE_IMAGE=node:20.11.1-bullseye-slim@sha256:5a5a92b3a8d392691c983719dbdc65d9f30085d6dcd65376e7a32e6fe9bf4cbe

FROM ${NODE_IMAGE} AS pruner

WORKDIR /triggerdotdev

COPY --chown=node:node . .
RUN npx -q turbo@1.10.9 prune --scope=webapp --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y openssl dumb-init
WORKDIR /triggerdotdev
COPY --chown=node:node .gitignore .gitignore
COPY --from=pruner --chown=node:node /triggerdotdev/out/json/ .
COPY --from=pruner --chown=node:node /triggerdotdev/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner --chown=node:node /triggerdotdev/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

## Dev deps
FROM base AS dev-deps
WORKDIR /triggerdotdev
# Corepack is used to install pnpm
RUN corepack enable
ENV NODE_ENV development
RUN pnpm install --ignore-scripts --no-frozen-lockfile

## Production deps
FROM base AS production-deps
WORKDIR /triggerdotdev
# Corepack is used to install pnpm
RUN corepack enable
ENV NODE_ENV production
RUN pnpm install --prod --no-frozen-lockfile
COPY --from=pruner --chown=node:node /triggerdotdev/internal-packages/database/prisma/schema.prisma /triggerdotdev/internal-packages/database/prisma/schema.prisma
# RUN pnpm add @prisma/client@5.1.1 -w
ENV NPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK true
RUN pnpx prisma@5.4.1 generate --schema /triggerdotdev/internal-packages/database/prisma/schema.prisma

## Builder (builds the webapp)
FROM base AS builder
WORKDIR /triggerdotdev
# Corepack is used to install pnpm
RUN corepack enable

COPY --from=pruner --chown=node:node /triggerdotdev/out/full/ .
COPY --from=dev-deps --chown=node:node /triggerdotdev/ .
COPY --chown=node:node turbo.json turbo.json
COPY --chown=node:node docker/scripts ./scripts
RUN chmod +x ./scripts/wait-for-it.sh
RUN chmod +x ./scripts/entrypoint.sh
COPY --chown=node:node .configs/tsconfig.base.json .configs/tsconfig.base.json
COPY --chown=node:node scripts/updateVersion.ts scripts/updateVersion.ts
RUN pnpm run generate
RUN pnpm run build --filter=webapp...

# Runner
FROM ${NODE_IMAGE} AS runner
RUN apt-get update && apt-get install -y openssl netcat-openbsd ca-certificates
WORKDIR /triggerdotdev
RUN corepack enable
ENV NODE_ENV production

COPY --from=base /usr/bin/dumb-init /usr/bin/dumb-init
COPY --from=pruner --chown=node:node /triggerdotdev/out/full/ .
COPY --from=production-deps --chown=node:node /triggerdotdev .
COPY --from=builder --chown=node:node /triggerdotdev/apps/webapp/build/server.js ./apps/webapp/build/server.js
COPY --from=builder --chown=node:node /triggerdotdev/apps/webapp/build ./apps/webapp/build
COPY --from=builder --chown=node:node /triggerdotdev/apps/webapp/public ./apps/webapp/public
COPY --from=builder --chown=node:node /triggerdotdev/apps/webapp/prisma/seed.js ./apps/webapp/prisma/seed.js
COPY --from=builder --chown=node:node /triggerdotdev/scripts ./scripts

EXPOSE 3000

USER node
CMD ["./scripts/entrypoint.sh"]
