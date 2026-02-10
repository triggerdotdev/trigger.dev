# Pull Request: Consolidated Fixes

## Title
fix: consolidated fixes for orphaned workers, Sentry OOM, and Docker Hub rate limits

## Description (copy this to GitHub PR)

### Summary
This PR consolidates several bug fixes for the CLI and core packages.

### Fixes Included
- **#2909**: Ensure worker cleanup on SIGINT/SIGTERM to prevent orphaned processes
- **#2920**: Allow disabling source-map-support to prevent OOM with Sentry
- **#2913**: Fix GitHub Actions node version compatibility during deploys
- **#2911**: Authenticate to Docker Hub to prevent rate limits
- **#2900**: Fix Sentry console log interception

### Changes

#### `packages/cli-v3/src/commands/dev.ts`
- Added SIGINT/SIGTERM signal handlers for proper worker cleanup on dev server exit

#### `packages/cli-v3/src/commands/update.ts`
- Cleaned up incompatible code for better maintainability

#### `packages/cli-v3/src/cli/common.ts`
- Added `ignoreEngines` option to CommonCommandOptions schema

#### `packages/cli-v3/src/commands/login.ts`
- Fixed missing `ignoreEngines` property in whoAmI calls

#### `packages/cli-v3/src/entryPoints/dev-run-worker.ts` & `managed-run-worker.ts`
- Added missing imports: `env`, `normalizeImportPath`, `VERSION`, `promiseWithResolvers`

#### `packages/core/src/v3/consoleInterceptor.ts`
- Fixed console interceptor to properly delegate to original methods (Sentry compatibility)

### Testing
- ✅ Local typecheck passes
- ✅ Unit tests pass for affected packages

---

## Instructions

1. Go to: https://github.com/deepshekhardas/trigger.dev
2. Click **"Contribute"** → **"Open pull request"**
3. Ensure:
   - Base: `triggerdotdev/trigger.dev` : `main`
   - Compare: `deepshekhardas/trigger.dev` : `main`
4. Copy the **Title** above into the PR title field
5. Copy the **Description** section above into the PR body
6. Click **"Create pull request"**
