#!/usr/bin/env bash
# 25 — SDK response shape audit. Hits each public apiClient method
# against a buffered run via the actual SDK so zodfetch's Zod schemas
# execute against the response. Catches schema drift between
# server-side synthesised responses and client-side parsers.
#
# Required: drainer OFF, gate tripped (TRIP_THRESHOLD=0 or burst-first).
#
# Pre-reqs: TRIGGER_API_URL + TRIGGER_SECRET_KEY env vars
# (defaults assume local dev: http://localhost:3030 with the seeded
# personal access token).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
exec pnpm --filter references-hello-world exec tsx \
  "$REPO_ROOT/scripts/mollifier-challenge/25-sdk-response-shape-audit.ts" "$@"
