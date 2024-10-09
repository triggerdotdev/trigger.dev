#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

# Run migrations
pnpm --filter @trigger.dev/database db:migrate:deploy

# Copy over required prisma files
cp internal-packages/database/prisma/schema.prisma apps/webapp/prisma/
cp node_modules/@prisma/engines/*.node apps/webapp/prisma/

cd /triggerdotdev/apps/webapp
# exec dumb-init pnpm run start:local
NODE_PATH='/triggerdotdev/node_modules/.pnpm/node_modules' exec dumb-init node --max-old-space-size=8192 ./build/server.js

