#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

section() {
  local title="$1"
  echo ""
  echo "::group::${title}"
}

end_section() {
  echo "::endgroup::"
}

run_section() {
  local title="$1"
  shift
  section "$title"

  local status=0
  if bash -euo pipefail -c '"$@"' bash "$@"; then
    status=0
  else
    status=$?
  fi

  end_section
  return "${status}"
}

find_node_bin() {
  local version_prefix="$1"

  if [[ ! -d /opt/hostedtoolcache/node ]]; then
    return 0
  fi

  find /opt/hostedtoolcache/node -maxdepth 3 -type d -path "*/${version_prefix}*/x64/bin" 2>/dev/null | sort -V | tail -n 1
}

with_node() {
  local node_bin="$1"
  shift

  if [[ -n "${node_bin}" ]]; then
    PATH="${node_bin}:${PATH}" "$@"
  else
    "$@"
  fi
}

run_webapp_unit_tests() {
  for shard in {1..10}; do
    echo "Running webapp unit test shard ${shard}/10"
    SHARD_INDEX="${shard}" SHARD_TOTAL="10" pnpm run test:webapp --reporter=default --shard="${shard}/10" --passWithNoTests
  done
}

run_package_unit_tests() {
  for shard in {1..3}; do
    echo "Running package unit test shard ${shard}/3"
    SHARD_INDEX="${shard}" SHARD_TOTAL="3" pnpm run test:packages --reporter=default --shard="${shard}/3" --passWithNoTests
  done
}

run_internal_unit_tests() {
  for shard in {1..12}; do
    echo "Running internal unit test shard ${shard}/12"
    SHARD_INDEX="${shard}" SHARD_TOTAL="12" pnpm run test:internal --reporter=default --shard="${shard}/12" --passWithNoTests
  done
}

run_webapp_e2e_tests() {
  pnpm run build --filter webapp
  (cd apps/webapp && WEBAPP_TEST_VERBOSE="1" pnpm exec vitest run --config vitest.e2e.config.ts --reporter=default)
}

run_cli_e2e_tests() {
  pnpm run build --filter trigger.dev^...
  pnpm --filter trigger.dev run --if-present build:workers
  corepack enable

  LOG=debug PM=npm pnpm --filter trigger.dev run test:e2e
  LOG=debug PM=pnpm pnpm --filter trigger.dev run test:e2e

  echo "Skipped the PR workflow's Windows CLI matrix row; this Testbox is Linux only."
}

run_sdk_node_compat_tests() {
  local node_bin="$1"
  local label="$2"

  with_node "${node_bin}" node --version
  with_node "${node_bin}" pnpm install --frozen-lockfile
  with_node "${node_bin}" pnpm run generate
  with_node "${node_bin}" pnpm run build --filter '@trigger.dev/sdk^...'
  with_node "${node_bin}" pnpm run build --filter '@trigger.dev/sdk'
  with_node "${node_bin}" pnpm --filter @internal/sdk-compat-tests test

  echo "Completed SDK Node compatibility checks for ${label}."
}

run_sdk_runtime_compat_tests() {
  local node20_bin="$1"

  with_node "${node20_bin}" pnpm run build --filter '@trigger.dev/sdk^...'
  with_node "${node20_bin}" pnpm run build --filter '@trigger.dev/sdk'

  (cd internal-packages/sdk-compat-tests/src/fixtures/bun && bun run test.ts)

  (
    cd internal-packages/sdk-compat-tests/src/fixtures/deno
    if [[ ! -e node_modules && ! -L node_modules ]]; then
      ln -s ../../../../../node_modules node_modules
    fi
    deno run --allow-read --allow-env --allow-sys test.ts
  )

  (
    cd internal-packages/sdk-compat-tests/src/fixtures/cloudflare-worker
    pnpm install
    npx wrangler deploy --dry-run --outdir dist
  )
}

export -f find_node_bin
export -f with_node
export -f run_webapp_unit_tests
export -f run_package_unit_tests
export -f run_internal_unit_tests
export -f run_webapp_e2e_tests
export -f run_cli_e2e_tests
export -f run_sdk_node_compat_tests
export -f run_sdk_runtime_compat_tests

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
export DIRECT_URL="${DIRECT_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
export SESSION_SECRET="${SESSION_SECRET:-secret}"
export MAGIC_LINK_SECRET="${MAGIC_LINK_SECRET:-secret}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-dummy-encryption-keeeey-32-bytes}"
export DEPLOY_REGISTRY_HOST="${DEPLOY_REGISTRY_HOST:-docker.io}"
export CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://default:password@localhost:8123}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

NODE20_BIN="${NODE20_BIN:-$(find_node_bin 20.20)}"
NODE22_BIN="${NODE22_BIN:-$(find_node_bin 22.12)}"

run_section "Install dependencies" pnpm install --frozen-lockfile
run_section "Generate Prisma client" pnpm run generate

run_section "Format check" pnpm exec oxfmt --check .
run_section "Lint" pnpm exec oxlint .
run_section "Typecheck" pnpm run typecheck
run_section "Check exports" pnpm run check-exports

run_section "Webapp unit tests" run_webapp_unit_tests
run_section "Package unit tests" run_package_unit_tests
run_section "Internal unit tests" run_internal_unit_tests
run_section "Webapp E2E tests" run_webapp_e2e_tests
run_section "CLI v3 E2E tests" run_cli_e2e_tests

run_section "SDK Node 20 compatibility tests" run_sdk_node_compat_tests "${NODE20_BIN}" "Node 20.20"
if [[ -n "${NODE22_BIN}" ]]; then
  run_section "SDK Node 22 compatibility tests" run_sdk_node_compat_tests "${NODE22_BIN}" "Node 22.12"
else
  echo "::warning::Node 22.12 was not found in /opt/hostedtoolcache; skipping SDK Node 22 compatibility tests."
fi
run_section "SDK Bun/Deno/Cloudflare compatibility tests" run_sdk_runtime_compat_tests "${NODE20_BIN}"

echo "All Linux PR checks completed."
