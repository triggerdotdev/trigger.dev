#!/usr/bin/env bash
set -euo pipefail
DAYS="${1:?days argument required}"
TZ="${2:-UTC}"
TZ="$TZ" date -d "${DAYS} days" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || TZ="$TZ" date -v"${DAYS}d" '+%Y-%m-%d %H:%M:%S %Z'
