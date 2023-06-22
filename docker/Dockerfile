FROM node:18 AS pruner

WORKDIR /triggerdotdev

COPY . .
RUN npx -q turbo prune --scope=webapp --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:18 AS base
RUN apt-get update && apt-get install -y openssl
WORKDIR /triggerdotdev
COPY .gitignore .gitignore
COPY --from=pruner /triggerdotdev/out/json/ .
COPY --from=pruner /triggerdotdev/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /triggerdotdev/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

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
COPY --from=pruner /triggerdotdev/packages/database/prisma/schema.prisma /triggerdotdev/packages/database/prisma/schema.prisma
RUN pnpx prisma generate --schema /triggerdotdev/packages/database/prisma/schema.prisma

## Builder (builds the webapp)
FROM base AS builder
WORKDIR /triggerdotdev
# Corepack is used to install pnpm
RUN corepack enable
COPY --from=pruner /triggerdotdev/out/full/ .
COPY --from=dev-deps /triggerdotdev/ .
COPY turbo.json turbo.json
COPY docker/scripts ./scripts
RUN chmod +x ./scripts/wait-for-it.sh
RUN chmod +x ./scripts/entrypoint.sh
RUN pnpm run generate
RUN pnpm run build --filter=webapp...

# Runner
FROM node:18 AS runner
RUN apt-get update && apt-get install -y openssl
WORKDIR /triggerdotdev
RUN corepack enable
ENV NODE_ENV production

COPY --from=pruner /triggerdotdev/out/full/ .
COPY --from=production-deps /triggerdotdev .
COPY --from=builder /triggerdotdev/apps/webapp/build/server.js ./apps/webapp/build/server.js
COPY --from=builder /triggerdotdev/apps/webapp/build ./apps/webapp/build
COPY --from=builder /triggerdotdev/apps/webapp/public ./apps/webapp/public
COPY --from=builder /triggerdotdev/scripts ./scripts

EXPOSE 3000

RUN npm install -g prisma@4.16.0
RUN npm install -g ts-node

CMD ["./scripts/entrypoint.sh"]