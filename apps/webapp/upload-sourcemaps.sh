#!/bin/bash
set -euo pipefail

if [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ] && [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_RELEASE" ]; then
  sentry-cli releases new $SENTRY_RELEASE
  sentry-cli sourcemaps inject ./build
  sentry-cli sourcemaps upload ./build --release $SENTRY_RELEASE
else
  echo "Skipping sourcemap upload: Missing required environment variables"
  echo "Required: SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, SENTRY_RELEASE"
fi
