#!/bin/sh
set -x

scripts/wait-for-it.sh ${DATABASE_HOST}:5432 -- echo "database is up"
npx prisma migrate deploy --schema /triggerdotdev/packages/database/prisma/schema.prisma
npx ts-node@latest --transpile-only /triggerdotdev/apps/webapp/prisma/seed.ts
npx turbo run start
