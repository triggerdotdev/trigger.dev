#!/usr/bin/env bash
set -euo pipefail

# Sync default model prices from Langfuse's repository and generate the TS module.
# Usage: ./scripts/sync-model-prices.sh [--check]
#   --check: Exit 1 if prices are outdated (for CI)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
JSON_TARGET="$PACKAGE_DIR/src/default-model-prices.json"
TS_TARGET="$PACKAGE_DIR/src/defaultPrices.ts"
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
    echo "Model prices are OUTDATED. Run 'pnpm run sync-prices' in @internal/llm-pricing to update."
    exit 1
  fi
fi

cp "$TMPFILE" "$JSON_TARGET"
echo "Updated default-model-prices.json ($MODEL_COUNT models)"

# Generate the TypeScript module from the JSON
echo "Generating defaultPrices.ts..."
node -e "
const data = JSON.parse(require('fs').readFileSync('$JSON_TARGET', 'utf-8'));
const stripped = data.map(e => ({
  modelName: e.modelName,
  matchPattern: e.matchPattern,
  startDate: e.createdAt,
  pricingTiers: e.pricingTiers.map(t => ({
    name: t.name,
    isDefault: t.isDefault,
    priority: t.priority,
    conditions: t.conditions.map(c => ({
      usageDetailPattern: c.usageDetailPattern,
      operator: c.operator,
      value: c.value,
    })),
    prices: t.prices,
  })),
}));

let out = 'import type { DefaultModelDefinition } from \"./types.js\";\n\n';
out += '// Auto-generated from Langfuse default-model-prices.json — do not edit manually.\n';
out += '// Run \`pnpm run sync-prices\` to update from upstream.\n';
out += '// Source: https://github.com/langfuse/langfuse\n\n';
out += 'export const defaultModelPrices: DefaultModelDefinition[] = ';
out += JSON.stringify(stripped, null, 2) + ';\n';
require('fs').writeFileSync('$TS_TARGET', out);
console.log('Generated defaultPrices.ts with ' + stripped.length + ' models');
"
