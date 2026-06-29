#!/usr/bin/env bash
set -euo pipefail

# Used inside Blacksmith Testbox runners to run full CI test suite

cd "$(git rev-parse --show-toplevel)"

declare -a SECTION_NAMES=()
declare -a SECTION_STATUSES=()
declare -a SECTION_DURATIONS=()
SUMMARY_PRINTED=0

format_duration() {
  local seconds="$1"
  printf "%dm%02ds" "$((seconds / 60))" "$((seconds % 60))"
}

section() {
  local title="$1"
  echo ""
  if [[ "${TEST_PR_CHECK_USE_GITHUB_GROUPS:-}" == "1" ]]; then
    echo "::group::${title}"
  else
    echo "▶ ${title}"
  fi
}

end_section() {
  if [[ "${TEST_PR_CHECK_USE_GITHUB_GROUPS:-}" == "1" ]]; then
    echo "::endgroup::"
  fi
}

record_section() {
  local title="$1"
  local status="$2"
  local duration="$3"

  SECTION_NAMES+=("${title}")
  SECTION_STATUSES+=("${status}")
  SECTION_DURATIONS+=("${duration}")
}

print_summary() {
  if [[ "${SUMMARY_PRINTED}" == "1" || "${#SECTION_NAMES[@]}" -eq 0 ]]; then
    return 0
  fi

  SUMMARY_PRINTED=1
  echo ""
  echo "PR check summary"
  echo "================"

  local failures=0
  local index
  for ((index = 0; index < ${#SECTION_NAMES[@]}; index++)); do
    local icon="✅"
    if [[ "${SECTION_STATUSES[$index]}" != "0" ]]; then
      icon="❌"
      failures=$((failures + 1))
    fi

    printf "%s %-42s %8s\n" \
      "${icon}" \
      "${SECTION_NAMES[$index]}" \
      "$(format_duration "${SECTION_DURATIONS[$index]}")"
  done

  if [[ "${failures}" -gt 0 ]]; then
    echo ""
    echo "${failures} section(s) failed."
  fi
}

has_failures() {
  local index
  for ((index = 0; index < ${#SECTION_STATUSES[@]}; index++)); do
    if [[ "${SECTION_STATUSES[$index]}" != "0" ]]; then
      return 0
    fi
  done

  return 1
}

on_exit() {
  local status="$?"
  print_summary
  exit "${status}"
}

trap on_exit EXIT

run_section() {
  local title="$1"
  shift
  local start
  start="$(date +%s)"

  section "$title"

  local status=0
  if bash -euo pipefail -c '"$@"' bash "$@"; then
    status=0
  else
    status=$?
  fi

  local duration
  duration="$(($(date +%s) - start))"
  record_section "${title}" "${status}" "${duration}"

  end_section

  if [[ "${status}" == "0" ]]; then
    echo "✅ ${title} passed in $(format_duration "${duration}")"
    return 0
  fi

  echo "❌ ${title} failed in $(format_duration "${duration}")"

  if [[ "${TEST_PR_CHECK_CONTINUE_ON_ERROR:-}" == "1" ]]; then
    return 0
  fi

  return "${status}"
}

find_node_bin() {
  local version_prefix="$1"

  if [[ ! -d /opt/hostedtoolcache/node ]]; then
    return 0
  fi

  find /opt/hostedtoolcache/node -maxdepth 3 -type d -path "*/${version_prefix}*/x64/bin" 2>/dev/null | sort -V | tail -n 1
}

ensure_pnpm() {
  local pnpm_version="${PNPM_VERSION:-10.33.2}"
  local npm_prefix="${HOME}/.npm-global"
  export PATH="${npm_prefix}/bin:${PATH}"

  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack prepare "pnpm@${pnpm_version}" --activate || true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "Unable to find pnpm or npm on PATH." >&2
    return 1
  fi

  mkdir -p "${npm_prefix}"
  npm config set prefix "${npm_prefix}"
  npm install -g "pnpm@${pnpm_version}"
  export PATH="${npm_prefix}/bin:${PATH}"

  command -v pnpm >/dev/null 2>&1
}

find_tool_bin() {
  local name="$1"
  shift

  local candidate
  for candidate in "$@"; do
    if [[ -x "${candidate}/${name}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  if [[ -d /opt/hostedtoolcache ]]; then
    find /opt/hostedtoolcache -maxdepth 6 -type f -name "${name}" -perm -u+x 2>/dev/null |
      head -n 1 |
      xargs -r dirname
  fi
}

ensure_bun() {
  export PATH="${HOME}/.bun/bin:${PATH}"

  if command -v bun >/dev/null 2>&1; then
    return 0
  fi

  local bin_dir
  bin_dir="$(find_tool_bin bun "${HOME}/.bun/bin")"
  if [[ -n "${bin_dir}" ]]; then
    export PATH="${bin_dir}:${PATH}"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "Unable to find bun on PATH, and curl is unavailable to install it." >&2
    return 1
  fi

  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
  command -v bun >/dev/null 2>&1
}

ensure_deno() {
  export PATH="${HOME}/.deno/bin:${PATH}"

  if command -v deno >/dev/null 2>&1; then
    return 0
  fi

  local bin_dir
  bin_dir="$(find_tool_bin deno "${HOME}/.deno/bin")"
  if [[ -n "${bin_dir}" ]]; then
    export PATH="${bin_dir}:${PATH}"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "Unable to find deno on PATH, and curl is unavailable to install it." >&2
    return 1
  fi

  curl -fsSL https://deno.land/install.sh | sh
  export PATH="${HOME}/.deno/bin:${PATH}"
  command -v deno >/dev/null 2>&1
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
export -f ensure_pnpm
export -f find_tool_bin
export -f ensure_bun
export -f ensure_deno
export -f with_node
export -f run_webapp_unit_tests
export -f run_package_unit_tests
export -f run_internal_unit_tests
export -f run_webapp_e2e_tests
export -f run_cli_e2e_tests
export -f run_sdk_node_compat_tests
export -f run_sdk_runtime_compat_tests

export CI="${CI:-true}"
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

if [[ -n "${NODE20_BIN}" ]]; then
  export PATH="${NODE20_BIN}:${PATH}"
fi

ensure_pnpm
ensure_bun
ensure_deno
pnpm --version
bun --version
deno --version

run_section "Install dependencies" pnpm install --frozen-lockfile

run_section "Format check" pnpm exec oxfmt --check .
run_section "Lint" pnpm exec oxlint .

run_section "Generate Prisma client" pnpm run generate
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

if has_failures; then
  exit 1
fi

echo "All Linux PR checks completed."
