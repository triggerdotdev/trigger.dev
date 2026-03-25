#!/usr/bin/env bash
set -euo pipefail

# Sync default model prices from Langfuse's repository and generate the TS module.
# Usage: ./scripts/sync-model-prices.sh [--check]
#   --check: Exit 1 if prices are outdated (for CI)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
JSON_TARGET="$PACKAGE_DIR/src/default-model-prices.json"
SOURCE_URL="https://raw.githubusercontent.com/langfuse/langfuse/main/worker/src/constants/default-model-prices.json"

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

echo "Fetching latest model prices from Langfuse..."
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

if ! curl -fsSL "$SOURCE_URL" -o "$TMPFILE"; then
  echo "ERROR: Failed to fetch from $SOURCE_URL"
  exit 1
fi

# Validate it's valid JSON with at least some models
MODEL_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMPFILE','utf-8')).length)" 2>/dev/null || echo "0")
if [[ "$MODEL_COUNT" -lt 10 ]]; then
  echo "ERROR: Downloaded file has only $MODEL_COUNT models (expected 100+). Aborting."
  exit 1
fi

if $CHECK_MODE; then
  if diff -q "$JSON_TARGET" "$TMPFILE" > /dev/null 2>&1; then
    echo "Model prices are up to date ($MODEL_COUNT models)"
    exit 0
  else
    echo "Model prices are OUTDATED. Run 'pnpm run sync-prices' in @internal/llm-model-catalog to update."
    exit 1
  fi
fi

cp "$TMPFILE" "$JSON_TARGET"
echo "Updated default-model-prices.json ($MODEL_COUNT models)"
echo "Run 'pnpm run generate' to regenerate defaultPrices.ts"
