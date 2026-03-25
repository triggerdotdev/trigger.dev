#!/usr/bin/env bash
set -euo pipefail

# Generate model-catalog.json by researching each unique base model using Claude Code CLI.
# Usage: ./scripts/generate-model-catalog.sh [options]
#
# Options:
#   --dry-run            Print models that would be researched without running Claude
#   --filter <pattern>   Only research models matching this ERE pattern (e.g. "gpt-4o|claude")
#   --max <n>            Maximum number of models to research (useful for testing)
#   --stale-days <n>     Re-research models older than N days (default: 7)
#   --force              Re-research all models regardless of resolvedAt timestamp
#   --skip-hidden        Skip models already marked as hidden/deprecated (saves time)
#   --concurrency <n>    Number of models to research in parallel (default: 5)
#
# The script:
# 1. Extracts all modelNames from defaultPrices.ts
# 2. Groups dated variants to their base model
# 3. Runs research-model.sh for each base model (in parallel)
# 4. Writes results incrementally to model-catalog.json
#
# Logs are written to scripts/logs/ for debugging failures.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
DEFAULTS_FILE="$PACKAGE_DIR/src/defaultPrices.ts"
CATALOG_FILE="$PACKAGE_DIR/src/model-catalog.json"
RESEARCH_SCRIPT="$SCRIPT_DIR/research-model.sh"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

DRY_RUN=false
FILTER=""
MAX_MODELS=0
STALE_DAYS=7
FORCE=false
SKIP_HIDDEN=false
CONCURRENCY=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --filter) FILTER="$2"; shift 2 ;;
    --max) MAX_MODELS="$2"; shift 2 ;;
    --stale-days) STALE_DAYS="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --skip-hidden) SKIP_HIDDEN=true; shift ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Extract all model names from defaultPrices.ts
ALL_MODELS=$(grep -o '"modelName": "[^"]*"' "$DEFAULTS_FILE" | sed 's/"modelName": "//;s/"//' | sort -u)

# Skip embedding, legacy completion, and fine-tuned models
SKIP_PATTERNS="^text-embedding|^textembedding|^text-ada|^text-babbage|^text-curie|^text-davinci|^text-bison|^text-unicorn|^code-bison|^code-gecko|^codechat-bison|^chat-bison|^babbage-002|^davinci-002|^ft:|^gemini-live"

FILTERED_MODELS=$(echo "$ALL_MODELS" | grep -vE "$SKIP_PATTERNS")

if [[ -n "$FILTER" ]]; then
  FILTERED_MODELS=$(echo "$FILTERED_MODELS" | grep -E "$FILTER" || true)
fi

# Group dated variants to base models
declare -A BASE_TO_VARIANTS
declare -A MODEL_TO_BASE

for model in $FILTERED_MODELS; do
  base=$(echo "$model" | sed -E 's/-[0-9]{4}-?[0-9]{2}-?[0-9]{2}$//')
  base_no_latest=$(echo "$base" | sed -E 's/-latest$//')
  if [[ ${#base_no_latest} -lt ${#base} ]]; then
    base="$base_no_latest"
  fi

  MODEL_TO_BASE["$model"]="$base"

  if [[ -n "${BASE_TO_VARIANTS[$base]:-}" ]]; then
    BASE_TO_VARIANTS["$base"]="${BASE_TO_VARIANTS[$base]} $model"
  else
    BASE_TO_VARIANTS["$base"]="$model"
  fi
done

BASE_MODELS=$(printf '%s\n' "${!BASE_TO_VARIANTS[@]}" | sort -u)
TOTAL=$(echo "$BASE_MODELS" | wc -l | tr -d ' ')

if [[ "$MAX_MODELS" -gt 0 ]]; then
  BASE_MODELS=$(echo "$BASE_MODELS" | head -n "$MAX_MODELS")
  TOTAL=$(echo "$BASE_MODELS" | wc -l | tr -d ' ')
fi

echo "Found $TOTAL unique base models (concurrency: $CONCURRENCY)"

if $DRY_RUN; then
  echo ""
  echo "Base models and their variants:"
  for base in $BASE_MODELS; do
    echo "  $base → ${BASE_TO_VARIANTS[$base]}"
  done
  exit 0
fi

# Load existing catalog
if [[ -f "$CATALOG_FILE" ]]; then
  EXISTING_CATALOG=$(cat "$CATALOG_FILE")
else
  EXISTING_CATALOG="{}"
fi

# Lock file for thread-safe catalog writes
LOCK_FILE="$LOG_DIR/.catalog.lock"
RESULTS_DIR="$LOG_DIR/results"
mkdir -p "$RESULTS_DIR"

ERRORS=0
FAILED_MODELS=""
SKIPPED=0
RESEARCHED=0
CHANGED=0

# --- Determine which models need research ---

MODELS_TO_RESEARCH=""
COUNT=0

for base in $BASE_MODELS; do
  COUNT=$((COUNT + 1))

  SKIP_REASON=$(echo "$EXISTING_CATALOG" | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    const entry = data['$base'];
    if (!entry) { process.stdout.write('missing'); return; }
    if ($FORCE) { process.stdout.write('force'); return; }
    if ($SKIP_HIDDEN && entry.isHidden) { process.stdout.write('hidden'); return; }
    const resolvedAt = entry.resolvedAt ? new Date(entry.resolvedAt) : null;
    if (!resolvedAt) { process.stdout.write('no_timestamp'); return; }
    const staleMs = $STALE_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - resolvedAt.getTime() > staleMs) { process.stdout.write('stale'); return; }
    process.stdout.write('fresh');
  " 2>/dev/null || echo "missing")

  case "$SKIP_REASON" in
    fresh)
      RESOLVED_DATE=$(echo "$EXISTING_CATALOG" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));const r=d['$base']?.resolvedAt;console.log(r?r.split('T')[0]:'?')" 2>/dev/null)
      echo "[$COUNT/$TOTAL] Skipping $base (resolved $RESOLVED_DATE)"
      SKIPPED=$((SKIPPED + 1))
      ;;
    hidden)
      echo "[$COUNT/$TOTAL] Skipping $base (hidden/deprecated)"
      SKIPPED=$((SKIPPED + 1))
      ;;
    *)
      MODELS_TO_RESEARCH="$MODELS_TO_RESEARCH $base"
      ;;
  esac
done

RESEARCH_COUNT=$(echo "$MODELS_TO_RESEARCH" | wc -w | tr -d ' ')
echo ""
echo "Researching $RESEARCH_COUNT models, skipped $SKIPPED"
echo ""

if [[ "$RESEARCH_COUNT" -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

# --- Research function (called per model, may run in parallel) ---

research_model() {
  local base="$1"
  local idx="$2"
  local total="$3"
  local model_log="$LOG_DIR/$base.log"
  local result_file="$RESULTS_DIR/$base.json"

  echo "[$idx/$total] Researching $base..."

  local raw
  raw=$("$RESEARCH_SCRIPT" "$base" 3 2>&1) || {
    echo "$raw" > "$model_log"
    echo "  ERROR: Failed to research $base (after retries). Log: $model_log" >&2
    echo '{"error":true}' > "$result_file"
    return 1
  }

  echo "$raw" > "$model_log"

  local entry
  entry=$(echo "$raw" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
      let text = (typeof d.result === 'string' ? d.result : JSON.stringify(d)).trim();
      text = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`\s*$/, '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) text = jsonMatch[0];
      const r = JSON.parse(text);
      if (!r.provider) throw new Error('missing provider field');
      process.stdout.write(JSON.stringify({
        provider: r.provider,
        description: r.description || '',
        contextWindow: r.contextWindow || null,
        maxOutputTokens: r.maxOutputTokens || null,
        capabilities: r.capabilities || [],
        releaseDate: r.releaseDate || null,
        isHidden: r.isHidden === true,
        supportsStructuredOutput: r.supportsStructuredOutput === true,
        supportsParallelToolCalls: r.supportsParallelToolCalls === true,
        supportsStreamingToolCalls: r.supportsStreamingToolCalls === true,
        deprecationDate: r.deprecationDate || null,
        knowledgeCutoff: r.knowledgeCutoff || null,
        resolvedAt: new Date().toISOString()
      }));
    } catch(e) {
      process.stderr.write(e.message);
      process.exit(1);
    }
  " 2>"$LOG_DIR/$base.parse-error") || {
    local parse_err
    parse_err=$(cat "$LOG_DIR/$base.parse-error" 2>/dev/null)
    echo "  ERROR: Failed to parse response for $base: $parse_err" >&2
    echo "  Raw response saved to: $model_log" >&2
    echo '{"error":true}' > "$result_file"
    return 1
  }

  echo "$entry" > "$result_file"
  echo "  OK: $(echo "$entry" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));console.log(d.provider + ' / ' + (d.contextWindow||'?') + ' ctx / ' + d.capabilities.length + ' caps')" 2>/dev/null)"
}

export -f research_model
export RESEARCH_SCRIPT LOG_DIR RESULTS_DIR

# --- Run research in parallel ---

IDX=0
PIDS=()
MODEL_LIST=($MODELS_TO_RESEARCH)

for base in "${MODEL_LIST[@]}"; do
  IDX=$((IDX + 1))

  research_model "$base" "$IDX" "$RESEARCH_COUNT" &
  PIDS+=($!)

  # Throttle concurrency
  if [[ ${#PIDS[@]} -ge $CONCURRENCY ]]; then
    wait "${PIDS[0]}" 2>/dev/null || true
    PIDS=("${PIDS[@]:1}")
  fi
done

# Wait for remaining
for pid in "${PIDS[@]}"; do
  wait "$pid" 2>/dev/null || true
done

echo ""
echo "Research complete. Merging results..."

# --- Merge results into catalog ---

CATALOG="$EXISTING_CATALOG"

for base in "${MODEL_LIST[@]}"; do
  RESULT_FILE="$RESULTS_DIR/$base.json"

  if [[ ! -f "$RESULT_FILE" ]]; then
    ERRORS=$((ERRORS + 1))
    FAILED_MODELS="$FAILED_MODELS $base"
    continue
  fi

  ENTRY=$(cat "$RESULT_FILE")

  # Check for error marker
  if echo "$ENTRY" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));process.exit(d.error?0:1)" 2>/dev/null; then
    ERRORS=$((ERRORS + 1))
    FAILED_MODELS="$FAILED_MODELS $base"
    continue
  fi

  RESEARCHED=$((RESEARCHED + 1))

  # Diff detection: compare with existing entry
  OLD_ENTRY=$(echo "$EXISTING_CATALOG" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    const e = d['$base'];
    if (e) { delete e.resolvedAt; process.stdout.write(JSON.stringify(e)); }
    else process.stdout.write('null');
  " 2>/dev/null)

  NEW_FOR_DIFF=$(echo "$ENTRY" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
    delete d.resolvedAt;
    process.stdout.write(JSON.stringify(d));
  " 2>/dev/null)

  if [[ "$OLD_ENTRY" != "null" && "$OLD_ENTRY" != "$NEW_FOR_DIFF" ]]; then
    CHANGED=$((CHANGED + 1))
    # Log what changed
    node -e "
      const old = JSON.parse('$OLD_ENTRY');
      const cur = JSON.parse('$NEW_FOR_DIFF');
      const changes = [];
      for (const k of new Set([...Object.keys(old), ...Object.keys(cur)])) {
        const o = JSON.stringify(old[k]); const n = JSON.stringify(cur[k]);
        if (o !== n) changes.push(k + ': ' + o + ' → ' + n);
      }
      if (changes.length) console.log('  CHANGED: ' + changes.join(', '));
    " 2>/dev/null || true
  fi

  # Apply to all variants of this base model
  for variant in ${BASE_TO_VARIANTS[$base]}; do
    CATALOG=$(echo "$CATALOG" | node -e "
      const catalog = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
      catalog['$variant'] = $ENTRY;
      process.stdout.write(JSON.stringify(catalog));
    ")
  done
done

# Write final catalog
echo "$CATALOG" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
  const sorted = Object.keys(data).sort().reduce((acc, k) => { acc[k] = data[k]; return acc; }, {});
  process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
" > "$CATALOG_FILE"

# Cleanup results
rm -rf "$RESULTS_DIR"

FINAL_COUNT=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$CATALOG_FILE','utf-8'))).length)")
echo ""
echo "Done! $FINAL_COUNT entries in catalog"
echo "  Researched: $RESEARCHED | Changed: $CHANGED | Skipped: $SKIPPED | Errors: $ERRORS"

if [[ "$ERRORS" -gt 0 ]]; then
  echo ""
  echo "Failed models:$FAILED_MODELS"
  RETRY_PATTERN=$(echo "$FAILED_MODELS" | tr ' ' '\n' | grep -v '^$' | sed 's/\./\\./g; s/^/^/; s/$/$/' | paste -sd '|' -)
  echo "Retry with: $0 --filter \"$RETRY_PATTERN\""
fi
