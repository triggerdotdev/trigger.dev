---
"trigger.dev": patch
---

Fix OOM during module loading caused by Sentry debug ID injection.

When using Sentry's `sentry-cli sourcemaps inject` command, every bundled file gets `new Error().stack` calls added for debug ID mapping. This caused `source-map-support` to parse all sourcemaps synchronously during the import phase, leading to Out Of Memory errors on memory-constrained machines (like `small-1x` with 0.5GB RAM) before any task code ran.

The fix implements "phase-based deferred sourcemap parsing":
- During module loading, sourcemap parsing is skipped
- After bootstrap completes, sourcemap parsing is enabled
- Runtime errors during task execution still get proper source-mapped stack traces

This trade-off means import errors won't have source-mapped stack traces, but they already have good bundler messages. The important runtime errors during actual task execution will continue to have full sourcemap support.
