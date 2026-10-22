#!/bin/sh
set -e

case " ${NODE_OPTIONS:-} " in
  *" --require=/app/scripts/distrust-cas.cjs "*) ;;
  *) export NODE_OPTIONS="--require=/app/scripts/distrust-cas.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}" ;;
esac

exec /usr/bin/dumb-init -- "$@"
