FROM node:18.16.1-bullseye-slim AS pruner

WORKDIR /triggerdotdev

COPY --chown=node:node . .
RUN npx -q turbo prune --scope=webapp --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:18.16.1-bullseye-slim AS base
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
COPY --from=pruner --chown=node:node /triggerdotdev/packages/database/prisma/schema.prisma /triggerdotdev/packages/database/prisma/schema.prisma
RUN pnpx prisma@^4.16.0 generate --schema /triggerdotdev/packages/database/prisma/schema.prisma

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
RUN pnpm run generate
RUN pnpm run build --filter=webapp...

# Runner
FROM node:18.16.1-bullseye-slim AS runner
RUN apt-get update && apt-get install -y openssl
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
