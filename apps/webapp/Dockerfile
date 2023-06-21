FROM node:18-bullseye-slim AS pruner
RUN apt-get update && apt-get install -y openssl
WORKDIR /app
RUN yarn global add turbo
COPY . .
RUN turbo prune --scope=webapp --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:18-bullseye-slim AS base
RUN apt-get update && apt-get install -y openssl
WORKDIR /app
COPY .gitignore .gitignore
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

FROM base AS dev-deps
WORKDIR /app
RUN corepack enable
RUN pnpm install --ignore-scripts --no-frozen-lockfile

FROM base AS production-deps
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN pnpm install --prod --no-frozen-lockfile
COPY --from=pruner /app/out/full/packages/database/prisma/schema.prisma /app/packages/database/prisma/schema.prisma
RUN pnpx prisma generate --schema /app/packages/database/prisma/schema.prisma

FROM base AS builder
WORKDIR /app
RUN corepack enable
# ENV NODE_ENV production
COPY --from=pruner /app/out/full/ .
COPY --from=dev-deps /app/ .
COPY turbo.json turbo.json
RUN pnpm run generate
RUN pnpm run build --filter=webapp...

# Runner
FROM node:18-bullseye-slim AS runner
RUN apt-get update && apt-get install -y openssl
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
# RUN addgroup --system --gid 1001 nodejs
# RUN adduser --system --uid 1001 remixjs
# RUN chown -R remixjs:nodejs /app
# USER remixjs

# COPY --from=pruner --chown=remixjs:nodejs /app/out/full/ .
# COPY --from=production-deps --chown=remixjs:nodejs /app .
# COPY --from=builder --chown=remixjs:nodejs /app/apps/remix-app/app/styles/tailwind.css ./apps/remix-app/app/styles/tailwind.css
# COPY --from=builder --chown=remixjs:nodejs /app/apps/remix-app/build/server.js ./apps/remix-app/build/server.js
# COPY --from=builder --chown=remixjs:nodejs /app/apps/remix-app/build ./apps/remix-app/build
# COPY --from=builder --chown=remixjs:nodejs /app/apps/remix-app/public ./apps/remix-app/public

COPY --from=pruner /app/out/full/ .
COPY --from=production-deps /app .
COPY --from=builder /app/apps/remix-app/app/styles/tailwind.css ./apps/remix-app/app/styles/tailwind.css
COPY --from=builder /app/apps/remix-app/build/server.js ./apps/remix-app/build/server.js
COPY --from=builder /app/apps/remix-app/build ./apps/remix-app/build
COPY --from=builder /app/apps/remix-app/public ./apps/remix-app/public


ENTRYPOINT ["pnpm", "--filter", "webapp", "run", "start"]