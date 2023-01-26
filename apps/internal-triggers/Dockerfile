FROM node:16-bullseye AS pruner
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
RUN npm install turbo -g
COPY . .
RUN turbo prune --scope=internal-triggers --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:16-bullseye AS base
RUN apt-get update && apt-get install openssl
WORKDIR /app
COPY .gitignore .gitignore
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

FROM base AS production-deps
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN pnpm install --prod --frozen-lockfile

FROM base AS builder
WORKDIR /app
RUN npm install turbo -g
COPY turbo.json turbo.json
RUN corepack enable
COPY --from=pruner /app/out/full/ .
ENV NODE_ENV development
RUN pnpm install --ignore-scripts --frozen-lockfile
ENV NODE_ENV production
RUN pnpm run build --filter=internal-triggers

# Runner
FROM node:16-bullseye AS runner
RUN apt-get update && apt-get install openssl
RUN npm install turbo -g
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 internal-triggersjs
RUN chown -R internal-triggersjs:nodejs /app
USER internal-triggersjs

COPY --from=pruner --chown=internal-triggersjs:nodejs /app/out/full/ .
COPY --from=production-deps --chown=internal-triggersjs:nodejs /app .
COPY --from=builder --chown=internal-triggersjs:nodejs /app/apps/internal-triggers/dist/index.js ./apps/internal-triggers/dist/index.js

ENTRYPOINT ["pnpm", "--filter", "internal-triggers", "run", "start"]