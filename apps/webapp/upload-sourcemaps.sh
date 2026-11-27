#!/bin/bash
set -eo pipefail

# Client maps are generated for the Sentry upload only; delete them in every branch so they are never served.
delete_sourcemaps() {
  rm -rf ./build/*.map
  if [ -d ./build/client ]; then
    find ./build/client -name '*.map' -delete
  fi
}

# Set during a Sentry outage so the image still builds.
if [ "$SKIP_SENTRY_SOURCEMAP_UPLOAD" = "true" ]; then
  echo "Skipping sourcemap upload: SKIP_SENTRY_SOURCEMAP_UPLOAD is true"
elif [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ] && [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_RELEASE" ]; then
  sentry-cli releases new $SENTRY_RELEASE
  sentry-cli sourcemaps inject ./build
  sentry-cli sourcemaps upload ./build --release $SENTRY_RELEASE
else
  echo "Skipping sourcemap upload: Missing required environment variables"
  echo "Required: SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN, SENTRY_RELEASE"
fi

delete_sourcemaps
