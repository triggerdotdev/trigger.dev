#!/bin/sh
set -x

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

# Run migrations
pnpm --filter @trigger.dev/database db:migrate:deploy

# Copy over required prisma files and invoke bundled seed file
cp packages/database/prisma/schema.prisma apps/webapp/prisma/
cp node_modules/@prisma/engines/*.node apps/webapp/prisma/
pnpm --filter webapp db:seed

cd /triggerdotdev/apps/webapp
exec dumb-init pnpm run start:local
