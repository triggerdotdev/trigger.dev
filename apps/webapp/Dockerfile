FROM node:16-bullseye AS pruner
RUN apt-get update && apt-get install openssl -y
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY . .
RUN turbo prune --scope=webapp --docker
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
RUN npm install turbo@1.7.0 -g
RUN corepack enable
ENV NODE_ENV production
RUN npm config set python /usr/bin/python3
COPY --from=pruner /app/out/full/apps/webapp/prisma/schema.prisma /app/apps/webapp/prisma/schema.prisma
RUN pnpm install --prod --frozen-lockfile
RUN pnpx prisma generate --schema /app/apps/webapp/prisma/schema.prisma

FROM base AS builder
WORKDIR /app
RUN npm install turbo@1.7.0 -g
COPY turbo.json turbo.json
RUN corepack enable
COPY --from=pruner /app/out/full/ .
RUN npm config set python /usr/bin/python3
ENV NODE_ENV development
RUN pnpm install --ignore-scripts --frozen-lockfile
ENV NODE_ENV production
RUN pnpm run generate
RUN pnpm run build --filter=webapp...
RUN pnpx prisma migrate deploy --schema apps/webapp/prisma/schema.prisma

# Runner
FROM node:16-bullseye AS runner
RUN apt-get update && apt-get install openssl ca-certificates g++ make wget python3 -y
ENV PULSAR_CPP_CLIENT_VERSION=2.10.3
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client.deb -q
RUN wget https://archive.apache.org/dist/pulsar/pulsar-${PULSAR_CPP_CLIENT_VERSION}/DEB/apache-pulsar-client-dev.deb -q
RUN dpkg -i ./apache-pulsar-client*.deb
RUN npm install turbo -g
WORKDIR /app
RUN corepack enable
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 remixjs
RUN chown -R remixjs:nodejs /app
USER remixjs

COPY --from=pruner --chown=remixjs:nodejs /app/out/full/ .
COPY --from=production-deps --chown=remixjs:nodejs /app .
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/app/styles/tailwind.css ./apps/webapp/app/styles/tailwind.css
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/build/server.js ./apps/webapp/build/server.js
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/build ./apps/webapp/build
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/public ./apps/webapp/public
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/prisma/schema.prisma ./apps/webapp/build/schema.prisma
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/prisma/migrations ./apps/webapp/build/migrations
COPY --from=builder --chown=remixjs:nodejs /app/apps/webapp/node_modules/.prisma/client/libquery_engine-debian-openssl-1.1.x.so.node ./apps/webapp/build/libquery_engine-debian-openssl-1.1.x.so.node

# release_command = "pnpx prisma migrate deploy --schema apps/webapp/prisma/schema.prisma"
ENTRYPOINT ["pnpm", "--filter", "webapp", "run", "start"]