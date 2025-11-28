#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

# Run migrations
echo "Running prisma migrations"
pnpm --filter @trigger.dev/database db:migrate:deploy
echo "Prisma migrations done"

if [ -n "$CLICKHOUSE_URL" ] && [ "$SKIP_CLICKHOUSE_MIGRATIONS" != "1" ]; then
  # Run ClickHouse migrations
  echo "Running ClickHouse migrations..."
  export GOOSE_DRIVER=clickhouse
  
  # Ensure secure=true is in the connection string
  if echo "$CLICKHOUSE_URL" | grep -q "secure="; then
    # secure parameter already exists, use as is
    export GOOSE_DBSTRING="$CLICKHOUSE_URL"
  elif echo "$CLICKHOUSE_URL" | grep -q "?"; then
    # URL has query parameters, append secure=true
    export GOOSE_DBSTRING="${CLICKHOUSE_URL}&secure=true"
  else
    # URL has no query parameters, add secure=true
    export GOOSE_DBSTRING="${CLICKHOUSE_URL}?secure=true"
  fi
  
  export GOOSE_MIGRATION_DIR=/triggerdotdev/internal-packages/clickhouse/schema
  /usr/local/bin/goose up
  echo "ClickHouse migrations complete."
elif [ "$SKIP_CLICKHOUSE_MIGRATIONS" = "1" ]; then
  echo "SKIP_CLICKHOUSE_MIGRATIONS=1, skipping ClickHouse migrations."
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

