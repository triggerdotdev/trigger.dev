#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

# Run migrations
echo "Running prisma migrations"
pnpm --filter @trigger.dev/database db:migrate:deploy
echo "Prisma migrations done"

if [ -n "$CLICKHOUSE_URL" ]; then
  # Run ClickHouse migrations
  echo "Running ClickHouse migrations..."
  export GOOSE_DRIVER=clickhouse
  export GOOSE_DBSTRING="$CLICKHOUSE_URL" # Use the full URL provided by the env var
  export GOOSE_MIGRATION_DIR=/triggerdotdev/internal-packages/clickhouse/schema
  /usr/local/bin/goose up
  echo "ClickHouse migrations complete."
else
  echo "CLICKHOUSE_URL not set, skipping ClickHouse migrations."
fi

# Copy over required prisma files
cp internal-packages/database/prisma/schema.prisma apps/webapp/prisma/
cp node_modules/@prisma/engines/*.node apps/webapp/prisma/

cd /triggerdotdev/apps/webapp


# Decide how much old-space memory Node should get.
# Use $NODE_MAX_OLD_SPACE_SIZE if it’s set; otherwise fall back to 8192.
MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-8192}"

echo "Setting max old space size to ${MAX_OLD_SPACE_SIZE}"

NODE_PATH='/triggerdotdev/node_modules/.pnpm/node_modules' exec dumb-init node --max-old-space-size=${MAX_OLD_SPACE_SIZE} ./build/server.js

