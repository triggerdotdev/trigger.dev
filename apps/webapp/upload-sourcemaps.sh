#!/bin/bash
set -eo pipefail

# Set during a Sentry outage so the image still builds; the maps are deleted either way so they never ship.
if [ "$SKIP_SENTRY_SOURCEMAP_UPLOAD" = "true" ]; then
  echo "Skipping sourcemap upload: SKIP_SENTRY_SOURCEMAP_UPLOAD is true"
  rm -rf ./build/*.map
elif [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ] && [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_RELEASE" ]; then
  sentry-cli releases new $SENTRY_RELEASE
  sentry-cli sourcemaps inject ./build
  sentry-cli sourcemaps upload ./build --release $SENTRY_RELEASE
  # Now we need to delete the sourcemaps from the build directory
  rm -rf ./build/*.map
else
  echo "Skipping sourcemap upload: Missing required environment variables"
  echo "Required: SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, SENTRY_RELEASE"
fi
