# Consolidated Bug Fixes

This PR combines fixes for several independent issues identified in the codebase, covering CLI stability, deployment/build reliability, and runtime correctness.

## Fixes

| Issue / Feature | Description |
|-----------------|-------------|
| **Orphaned Workers** | Fixes `trigger dev` leaving orphaned `trigger-dev-run-worker` processes by ensuring graceful shutdown on `SIGINT`/`SIGTERM` and robust process cleanup. |
| **Sentry Interception** | Fixes `ConsoleInterceptor` swallowing logs when Sentry (or other monkey-patchers) are present by delegating to the original preserved console methods. |
| **Engine Strictness** | Fixes deployment failures on GitHub Integration when `engines.node` is strict (e.g. "22") by passing `--no-engine-strict` (and equivalents) during the `trigger deploy` build phase. |
| **Docker Hub Rate Limits** | Adds support for `DOCKER_USERNAME` and `DOCKER_PASSWORD` in `buildImage.ts` to authenticate with Docker Hub and avoid rate limits during native builds. |
| **Dead Process Hang** | Fixes a hang in `TaskRunProcess.execute()` by checking specific process connectivity before attempting to send IPC messages. |
| **Superjson ESM** | Bundles `superjson` into `packages/core/src/v3/vendor` to resolve `ERR_REQUIRE_ESM` issues in certain environments (Lambda, Node <22.12). |
| **Realtime Hooks** | Fixes premature firing of `onComplete` in `useRealtime` hooks when the stream disconnects but the run hasn't actually finished. |
| **Stream Targets** | Aligns `getRunIdForOptions` logic between SDK and Core to ensure Consistent semantic targets for streams. |
| **Hook Exports** | Exports `AnyOnStartAttemptHookFunction` from `trigger-sdk` to allow proper typing of `onStartAttempt`. |

## Verification

### Automated Verification
- **Engine Strictness**: Pass in `packages/cli-v3/src/commands/update.test.ts`.
- **Superjson**: Validated via reproduction scripts importing the vendored bundle in both ESM and CJS modes.
- **Sentry**: Validated via `repro_2900_sentry.ts` script ensuring logs flow through Sentry patches.

### Manual Verification
- **Orphaned Workers**: Verified locally by interrupting `trigger dev` and observing process cleanup.
- **Docker Hub**: Verified code logic correctly identifies env vars and executes login.
- **React Hooks & Streams**: Verified by code review of the corrected logic matching the intended fix.

## Changesets
- `fix-orphaned-workers-2909`
- `fix-sentry-console-interceptor-2900`
- `fix-github-install-node-version-2913`
- `fix-docker-hub-rate-limit-2911`
- `fix-dead-process-execute-hang`
- `vendor-superjson-esm-fix`
- `calm-hooks-wait`
- `consistent-stream-targets`
- `export-start-attempt-hook-type`
