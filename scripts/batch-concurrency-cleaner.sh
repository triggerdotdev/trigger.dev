#!/bin/bash
#
# Batch Queue Concurrency Cleaner
#
# Detects and cleans up stale concurrency entries that block batch processing.
# This is a workaround for a bug where visibility timeout reclaims don't release concurrency.
#
# Uses a Lua script for ATOMIC detection of stale entries - no race conditions.
#
# Usage:
#   ./batch-concurrency-cleaner.sh --read-redis <url> --write-redis <url> [--delay <seconds>] [--dry-run]
#

set -e

# Defaults
DELAY=10
DRY_RUN=false
READ_REDIS=""
WRITE_REDIS=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --read-redis)
      READ_REDIS="$2"
      shift 2
      ;;
    --write-redis)
      WRITE_REDIS="$2"
      shift 2
      ;;
    --delay)
      DELAY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 --read-redis <url> --write-redis <url> [--delay <seconds>] [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$READ_REDIS" ]] || [[ -z "$WRITE_REDIS" ]]; then
  echo "Error: --read-redis and --write-redis are required"
  exit 1
fi

echo "Batch Queue Concurrency Cleaner (Atomic Version)"
echo "================================================="
echo "Read Redis:  ${READ_REDIS:0:30}..."
echo "Write Redis: ${WRITE_REDIS:0:30}..."
echo "Delay:       ${DELAY}s"
echo "Dry run:     $DRY_RUN"
echo ""

rcli_read() {
  redis-cli -u "$READ_REDIS" --no-auth-warning "$@" 2>/dev/null
}

rcli_write() {
  redis-cli -u "$WRITE_REDIS" --no-auth-warning "$@" 2>/dev/null
}

# Lua script that ATOMICALLY checks for stale concurrency entries
# KEYS[1] = concurrency key to check
# KEYS[2-13] = in-flight data hash keys for shards 0-11
# Returns: list of stale messageIds (not in any in-flight hash)
FIND_STALE_LUA='
local concurrency_key = KEYS[1]
local stale = {}

-- Get all members of the concurrency set
local members = redis.call("SMEMBERS", concurrency_key)

for _, msg_id in ipairs(members) do
  local found = false
  -- Check each in-flight shard (KEYS[2] through KEYS[13])
  for i = 2, 13 do
    if redis.call("HEXISTS", KEYS[i], msg_id) == 1 then
      found = true
      break
    end
  end
  if not found then
    table.insert(stale, msg_id)
  end
end

return stale
'

# Build the in-flight keys array (used in every Lua call)
INFLIGHT_KEYS="engine:batch:inflight:0:data"
for shard in 1 2 3 4 5 6 7 8 9 10 11; do
  INFLIGHT_KEYS="$INFLIGHT_KEYS engine:batch:inflight:$shard:data"
done

# Main loop
while true; do
  ts=$(date '+%H:%M:%S')

  # Get master queue total and in-flight count for status display
  master_total=0
  for i in 0 1 2 3 4 5 6 7 8 9 10 11; do
    count=$(rcli_read ZCARD "engine:batch:master:$i")
    master_total=$((master_total + count))
  done

  inflight_total=0
  for i in 0 1 2 3 4 5 6 7 8 9 10 11; do
    count=$(rcli_read HLEN "engine:batch:inflight:$i:data")
    inflight_total=$((inflight_total + count))
  done

  # Scan for concurrency keys
  cursor=0
  total_stale=0
  cleaned_tenants=0

  while true; do
    scan_output=$(rcli_read SCAN $cursor MATCH 'engine:batch:concurrency:tenant:*' COUNT 1000)
    cursor=$(echo "$scan_output" | head -1)
    keys=$(echo "$scan_output" | tail -n +2)

    while IFS= read -r conc_key; do
      [[ -z "$conc_key" ]] && continue

      # ATOMIC check: Run Lua script to find stale entries
      # 13 keys total: 1 concurrency key + 12 in-flight keys
      stale_ids=$(rcli_read EVAL "$FIND_STALE_LUA" 13 "$conc_key" $INFLIGHT_KEYS)

      # Count stale entries
      stale_count=0
      stale_array=()
      while IFS= read -r stale_id; do
        [[ -z "$stale_id" ]] && continue
        stale_array+=("$stale_id")
        stale_count=$((stale_count + 1))
      done <<< "$stale_ids"

      if [[ $stale_count -gt 0 ]]; then
        tenant="${conc_key#engine:batch:concurrency:tenant:}"
        total_stale=$((total_stale + stale_count))

        if [[ "$DRY_RUN" == "true" ]]; then
          echo "[$ts] STALE (dry-run): $tenant ($stale_count entries)"
          for sid in "${stale_array[@]}"; do
            echo "       - $sid"
          done
        else
          # Remove each stale entry individually with SREM (idempotent, safe)
          for sid in "${stale_array[@]}"; do
            rcli_write SREM "$conc_key" "$sid" >/dev/null
          done
          echo "[$ts] CLEANED: $tenant ($stale_count stale entries removed)"
          cleaned_tenants=$((cleaned_tenants + 1))
        fi
      fi
    done <<< "$keys"

    [[ "$cursor" == "0" ]] && break
  done

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[$ts] in-flight=$inflight_total master-queue=$master_total stale-found=$total_stale"
  else
    echo "[$ts] in-flight=$inflight_total master-queue=$master_total cleaned=$cleaned_tenants"
  fi

  sleep "$DELAY"
done
