FROM node:16-bullseye AS pruner
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY . .
RUN turbo prune --scope=wss --docker
RUN find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# Base strategy to have layer caching
FROM node:16-bullseye AS base
RUN apt-get update && apt-get install openssl ca-certificates g++ make wget python3 -y
ENV PULSAR_CPP_CLIENT_VERSION=2.10.3
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client.deb -q
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client-dev.deb -q
RUN dpkg -i ./apache-pulsar-client*.deb
WORKDIR /app
COPY .gitignore .gitignore
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml

FROM base AS production-deps
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN npm config set python /usr/bin/python3
RUN pnpm --version
RUN pnpm install --prod --no-frozen-lockfile

FROM base AS builder
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY turbo.json turbo.json
RUN corepack enable
COPY --from=pruner /app/out/full/ .
RUN npm config set python /usr/bin/python3
ENV NODE_ENV development
RUN pnpm --version
RUN pnpm install --ignore-scripts --no-frozen-lockfile
ENV NODE_ENV production
RUN pnpm run build --filter=wss

# Runner
FROM node:16-bullseye AS runner
RUN apt-get update && apt-get install openssl ca-certificates g++ make wget python3 -y
ENV PULSAR_CPP_CLIENT_VERSION=2.10.3
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client.deb -q
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client-dev.deb -q
RUN dpkg -i ./apache-pulsar-client*.deb
RUN npm install turbo@1.7.0 -g
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 wssjs
RUN chown -R wssjs:nodejs /app
USER wssjs

COPY --from=pruner --chown=wssjs:nodejs /app/out/full/ .
COPY --from=production-deps --chown=wssjs:nodejs /app .
COPY --from=builder --chown=wssjs:nodejs /app/apps/wss/dist/index.js ./apps/wss/dist/index.js

ENTRYPOINT ["pnpm", "--filter", "wss", "run", "start"]