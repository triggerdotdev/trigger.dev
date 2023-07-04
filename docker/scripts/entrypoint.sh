#!/bin/sh
set -x

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

npx --no-install prisma migrate deploy --schema /triggerdotdev/packages/database/prisma/schema.prisma
npx --no-install ts-node --transpile-only /triggerdotdev/apps/webapp/prisma/seed.ts

cd /triggerdotdev/apps/webapp
exec pnpm run start
