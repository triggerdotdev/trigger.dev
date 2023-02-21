FROM node:16-bullseye AS pruner
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY . .
RUN turbo prune --scope=integrations --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:16-bullseye AS base
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
COPY .gitignore .gitignore
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

FROM base AS production-deps
WORKDIR /app
RUN npm install turbo@1.7.0 -g
RUN corepack enable
ENV NODE_ENV production
COPY --from=pruner /app/out/full/apps/integrations/prisma/schema.prisma /app/apps/integrations/prisma/schema.prisma
RUN pnpm install --prod --no-frozen-lockfile
RUN pnpx prisma generate --schema /app/apps/integrations/prisma/schema.prisma

FROM base AS builder
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY turbo.json turbo.json
RUN corepack enable
COPY --from=pruner /app/out/full/ .
ENV NODE_ENV development
RUN pnpm install --ignore-scripts --no-frozen-lockfile
ENV NODE_ENV production
RUN pnpm run generate
RUN pnpm run build --filter=integrations...
RUN pnpx prisma migrate deploy --schema apps/integrations/prisma/schema.prisma

# Runner
FROM node:16-bullseye AS runner
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 expressjs
RUN chown -R expressjs:nodejs /app
USER expressjs

COPY --from=pruner --chown=expressjs:nodejs /app/out/full/ .
COPY --from=production-deps --chown=expressjs:nodejs /app .
COPY --from=builder --chown=expressjs:nodejs /app/apps/integrations/dist/index.js ./apps/integrations/dist/index.js

ENTRYPOINT ["pnpm", "--filter", "integrations", "run", "start"]