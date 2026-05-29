#!/usr/bin/env bash
set -euo pipefail
TZ="${1:-UTC}"
TZ="$TZ" date -u '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || TZ="$TZ" date '+%Y-%m-%d %H:%M:%S %Z'
