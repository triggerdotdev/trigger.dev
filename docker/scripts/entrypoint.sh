#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

if [ "$SKIP_POSTGRES_MIGRATIONS" != "1" ]; then
  echo "Running prisma migrations"
  pnpm --filter @trigger.dev/database db:migrate:deploy
  echo "Prisma migrations done"
else
  echo "SKIP_POSTGRES_MIGRATIONS=1, skipping Postgres migrations."
fi

# Run-ops split: migrate the dedicated NEW run-ops database only when it is configured. Single-DB
# installs never set the URL, so this is a no-op there.
{ set +x; } 2>/dev/null
if [ -n "$RUN_OPS_DATABASE_URL" ]; then
  set -x
  if [ "$SKIP_RUN_OPS_MIGRATIONS" != "1" ]; then
    echo "Running run-ops migrations"
    pnpm --filter @internal/run-ops-database db:migrate:deploy
    echo "Run-ops migrations done"
  else
    echo "SKIP_RUN_OPS_MIGRATIONS=1, skipping run-ops migrations."
  fi
else
  set -x
  echo "RUN_OPS_DATABASE_URL not set, skipping run-ops migrations."
fi

# Run-ops split: keep the legacy runs DB's schema current by applying the full @trigger.dev/database
# migrations to it too, pointed at its direct (non-pooled) URL. Only runs when that URL is configured;
# installs that never set it skip this entirely.
{ set +x; } 2>/dev/null
if [ -n "$RUN_OPS_LEGACY_DIRECT_URL" ]; then
  set -x
  if [ "$SKIP_RUN_OPS_LEGACY_MIGRATIONS" != "1" ]; then
    echo "Running legacy run-ops migrations"
    # Subshell with tracing off so `set -x` does not print the DSN (with credentials) to the logs.
    (set +x; DATABASE_URL="$RUN_OPS_LEGACY_DIRECT_URL" DIRECT_URL="$RUN_OPS_LEGACY_DIRECT_URL" pnpm --filter @trigger.dev/database db:migrate:deploy)
    echo "Legacy run-ops migrations done"
  else
    echo "SKIP_RUN_OPS_LEGACY_MIGRATIONS=1, skipping legacy run-ops migrations."
  fi
else
  set -x
  echo "RUN_OPS_LEGACY_DIRECT_URL not set, skipping legacy run-ops migrations."
fi

# Run-ops shards: migrate every gen-2 shard that owns its own database. Each shard runs the
# identical schema, so this is the existing run-ops migrations against a new DSN. An aliased shard is
# skipped by the DSN script: it IS its target's database. Installs that never set RUN_OPS_SHARDS
# skip this entirely.
{ set +x; } 2>/dev/null
if [ -n "$RUN_OPS_SHARDS" ]; then
  set -x
  if [ "$SKIP_RUN_OPS_SHARD_MIGRATIONS" != "1" ]; then
    echo "Running run-ops shard migrations"
    # Tracing stays OFF from here to the end of the loop: `set -x` prints an assignment, so
    # capturing a DSN under tracing would put the credentials in the logs.
    { set +x; } 2>/dev/null
    # A malformed descriptor exits 1 here, so the container stops before it migrates anything.
    shard_dsns=$(node scripts/runOpsShardDsns.mjs)
    # A `for` loop and NOT `... | while read`: a pipeline subshell would swallow a failed migration
    # on any iteration but the last. Here `set -e` stops the boot on the first shard that fails.
    # The whole loop runs in a subshell, so the IFS and `set -f` changes need no restore and cannot
    # leak into the rest of the entrypoint. IFS is newline-only so a DSN is never split on other
    # whitespace, and `set -f` stops a DSN query string (it holds `?`) from acting as a glob.
    (
      IFS='
'
      set -f
      for shard_dsn in $shard_dsns; do
        # Tracing stays off so `set -x` never prints the DSN (with credentials) to the logs.
        RUN_OPS_DATABASE_URL="$shard_dsn" DIRECT_URL="$shard_dsn" pnpm --filter @internal/run-ops-database db:migrate:deploy
      done
    )
    set -x
    echo "Run-ops shard migrations done"
  else
    echo "SKIP_RUN_OPS_SHARD_MIGRATIONS=1, skipping run-ops shard migrations."
  fi
else
  set -x
  echo "RUN_OPS_SHARDS not set, skipping run-ops shard migrations."
fi

if [ "$SKIP_DASHBOARD_AGENT_MIGRATIONS" != "1" ]; then
  echo "Running dashboard agent migrations"
  pnpm --filter @internal/dashboard-agent-db db:migrate:deploy
  echo "Dashboard agent migrations done"
else
  echo "SKIP_DASHBOARD_AGENT_MIGRATIONS=1, skipping dashboard agent migrations."
fi

{ set +x; } 2>/dev/null
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
set -x

# Copy over required prisma files
cp internal-packages/database/prisma/schema.prisma apps/webapp/prisma/
cp node_modules/@prisma/engines/*.node apps/webapp/prisma/

cd /triggerdotdev/apps/webapp


# Decide how much old-space memory Node should get.
# Use $NODE_MAX_OLD_SPACE_SIZE if it’s set; otherwise fall back to 8192.
MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-8192}"

echo "Setting max old space size to ${MAX_OLD_SPACE_SIZE}"

NODE_PATH='/triggerdotdev/node_modules/.pnpm/node_modules' exec dumb-init node --max-old-space-size=${MAX_OLD_SPACE_SIZE} ./build/server.js

