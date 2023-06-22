#!/bin/sh
set -x

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

npx prisma migrate deploy --schema /triggerdotdev/packages/database/prisma/schema.prisma
npx ts-node@latest --transpile-only /triggerdotdev/apps/webapp/prisma/seed.ts
npx turbo run start
