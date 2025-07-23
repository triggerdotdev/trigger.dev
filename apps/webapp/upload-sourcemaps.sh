#!/bin/bash
if [ -n "$SENTRY_ORG" ] && [ -n "$SENTRY_PROJECT" ] && [ -n "$SENTRY_AUTH_TOKEN" ]; then
  sentry-upload-sourcemaps --org $SENTRY_ORG --project $SENTRY_PROJECT --buildPath ./build
else
  echo "Skipping sourcemap upload: Missing required environment variables"
  echo "Required: SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN"
fi
