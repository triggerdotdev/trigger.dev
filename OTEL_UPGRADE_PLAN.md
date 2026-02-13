# OpenTelemetry Package Upgrade Plan

## Overview

This plan covers upgrading all `@opentelemetry/*` packages across the monorepo to the latest coordinated release, and adding the packages needed to support OTEL metrics in `@trigger.dev/core`.

The OpenTelemetry JS project releases packages in three synchronized version tracks. The latest coordinated release (February 12, 2026) includes:

| Track | Version | Packages |
|-------|---------|----------|
| **API** | `1.9.0` | `@opentelemetry/api` |
| **Stable SDK** | `2.5.1` | `core`, `resources`, `sdk-trace-base`, `sdk-trace-node`, `sdk-trace-web`, `sdk-metrics` |
| **Experimental** | `0.212.0` | `sdk-node`, `sdk-logs`, `api-logs`, `instrumentation`, all OTLP exporters |
| **Semantic Conventions** | `1.39.0` | `@opentelemetry/semantic-conventions` |

All stable `2.x` and experimental `0.2xx` packages require `@opentelemetry/api >=1.3.0 <1.10.0`, so `1.9.0` remains the correct API version.

---

## Current State

### packages/core (`@trigger.dev/core`)

| Package | Current | Target | Delta |
|---------|---------|--------|-------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 | — |
| `@opentelemetry/api-logs` | 0.203.0 | 0.212.0 | patch* |
| `@opentelemetry/core` | 2.0.1 | 2.5.1 | minor |
| `@opentelemetry/exporter-logs-otlp-http` | 0.203.0 | 0.212.0 | patch* |
| `@opentelemetry/exporter-trace-otlp-http` | 0.203.0 | 0.212.0 | patch* |
| `@opentelemetry/instrumentation` | 0.203.0 | 0.212.0 | patch* |
| `@opentelemetry/resources` | 2.0.1 | 2.5.1 | minor |
| `@opentelemetry/sdk-logs` | 0.203.0 | 0.212.0 | patch* |
| `@opentelemetry/sdk-trace-base` | 2.0.1 | 2.5.1 | minor |
| `@opentelemetry/sdk-trace-node` | 2.0.1 | 2.5.1 | minor |
| `@opentelemetry/semantic-conventions` | 1.36.0 | 1.39.0 | minor |
| **`@opentelemetry/sdk-metrics`** | _(new)_ | 2.5.1 | **add** |
| **`@opentelemetry/exporter-metrics-otlp-http`** | _(new)_ | 0.212.0 | **add** |

\* Experimental track uses 0.x versioning; these are all coordinated releases.

### packages/cli-v3 (`trigger.dev`)

| Package | Current | Target |
|---------|---------|--------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 |
| `@opentelemetry/api-logs` | 0.203.0 | 0.212.0 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.203.0 | 0.212.0 |
| `@opentelemetry/instrumentation` | 0.203.0 | 0.212.0 |
| `@opentelemetry/instrumentation-fetch` | 0.203.0 | 0.212.0 |
| `@opentelemetry/resources` | 2.0.1 | 2.5.1 |
| `@opentelemetry/sdk-trace-node` | 2.0.1 | 2.5.1 |
| `@opentelemetry/semantic-conventions` | 1.36.0 | 1.39.0 |

### packages/trigger-sdk (`@trigger.dev/sdk`)

| Package | Current | Target |
|---------|---------|--------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 |
| `@opentelemetry/semantic-conventions` | 1.36.0 | 1.39.0 |

### apps/webapp

| Package | Current | Target |
|---------|---------|--------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 |
| `@opentelemetry/api-logs` | 0.203.0 | 0.212.0 |
| `@opentelemetry/core` | 2.0.1 | 2.5.1 |
| `@opentelemetry/exporter-logs-otlp-http` | 0.203.0 | 0.212.0 |
| `@opentelemetry/exporter-metrics-otlp-proto` | 0.203.0 | 0.212.0 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.203.0 | 0.212.0 |
| `@opentelemetry/host-metrics` | ^0.36.0 | check latest compat |
| `@opentelemetry/instrumentation` | 0.203.0 | 0.212.0 |
| `@opentelemetry/instrumentation-aws-sdk` | ^0.57.0 | check latest compat |
| `@opentelemetry/instrumentation-express` | ^0.52.0 | check latest compat |
| `@opentelemetry/instrumentation-http` | 0.203.0 | 0.212.0 |
| `@opentelemetry/resource-detector-aws` | ^2.3.0 | check latest compat |
| `@opentelemetry/resources` | 2.0.1 | 2.5.1 |
| `@opentelemetry/sdk-logs` | 0.203.0 | 0.212.0 |
| `@opentelemetry/sdk-metrics` | 2.0.1 | 2.5.1 |
| `@opentelemetry/sdk-node` | 0.203.0 | 0.212.0 |
| `@opentelemetry/sdk-trace-base` | 2.0.1 | 2.5.1 |
| `@opentelemetry/sdk-trace-node` | 2.0.1 | 2.5.1 |
| `@opentelemetry/semantic-conventions` | 1.36.0 | 1.39.0 |
| `@prisma/instrumentation` | ^6.14.0 | ^6.14.0 (unchanged) |

### internal-packages/tracing (`@internal/tracing`)

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `@opentelemetry/api` | 1.9.0 | 1.9.0 | — |
| `@opentelemetry/api-logs` | **0.52.1** | 0.212.0 | **Very stale — major version jump** |
| `@opentelemetry/semantic-conventions` | ^1.27.0 | 1.39.0 | Pin to exact version |

---

## Phase 1: Upgrade existing packages

### Step 1.1: Upgrade `packages/core`

Update `packages/core/package.json` dependencies:

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/api-logs": "0.212.0",
  "@opentelemetry/core": "2.5.1",
  "@opentelemetry/exporter-logs-otlp-http": "0.212.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.212.0",
  "@opentelemetry/instrumentation": "0.212.0",
  "@opentelemetry/resources": "2.5.1",
  "@opentelemetry/sdk-logs": "0.212.0",
  "@opentelemetry/sdk-trace-base": "2.5.1",
  "@opentelemetry/sdk-trace-node": "2.5.1",
  "@opentelemetry/semantic-conventions": "1.39.0"
}
```

**Breaking change to address in `tracingSDK.ts`:**

The import `SemanticResourceAttributes` and `SEMATTRS_HTTP_URL` from `@opentelemetry/semantic-conventions` were deprecated in `1.26.0` and are no longer available in newer versions. They have been replaced by `ATTR_*` constants from `@opentelemetry/semantic-conventions/incubating` or by the `SEMRESATTRS_*` constants. Specifically:

- `SemanticResourceAttributes.CLOUD_PROVIDER` → `ATTR_CLOUD_PROVIDER` (from `@opentelemetry/semantic-conventions/incubating`) or inline string `"cloud.provider"`
- `SemanticResourceAttributes.SERVICE_NAME` → `ATTR_SERVICE_NAME` (from `@opentelemetry/semantic-conventions`) or inline string `"service.name"`
- `SEMATTRS_HTTP_URL` → `ATTR_HTTP_URL` (from `@opentelemetry/semantic-conventions/incubating`) or inline string `"http.url"`

**Action items:**
1. Check if `SemanticResourceAttributes` and `SEMATTRS_HTTP_URL` still exist in `1.39.0` (they may be preserved for backwards compat). If not, replace with string literals or new constants.
2. Run `pnpm run build --filter @trigger.dev/core` and fix any compilation errors.
3. Run `pnpm run test --filter @trigger.dev/core` and verify tests pass.

### Step 1.2: Upgrade `packages/cli-v3`

Update `packages/cli-v3/package.json` dependencies:

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/api-logs": "0.212.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.212.0",
  "@opentelemetry/instrumentation": "0.212.0",
  "@opentelemetry/instrumentation-fetch": "0.212.0",
  "@opentelemetry/resources": "2.5.1",
  "@opentelemetry/sdk-trace-node": "2.5.1",
  "@opentelemetry/semantic-conventions": "1.39.0"
}
```

**Action items:**
1. Check for any usage of deprecated `SemanticResourceAttributes` or `SEMATTRS_*` constants in CLI source code.
2. Build and test: `pnpm run build --filter trigger.dev`

### Step 1.3: Upgrade `packages/trigger-sdk`

Update `packages/trigger-sdk/package.json`:

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/semantic-conventions": "1.39.0"
}
```

**Action items:**
1. Check for deprecated semantic convention imports in SDK source.
2. Build and test: `pnpm run build --filter @trigger.dev/sdk`

### Step 1.4: Upgrade `apps/webapp`

Update `apps/webapp/package.json`:

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/api-logs": "0.212.0",
  "@opentelemetry/core": "2.5.1",
  "@opentelemetry/exporter-logs-otlp-http": "0.212.0",
  "@opentelemetry/exporter-metrics-otlp-proto": "0.212.0",
  "@opentelemetry/exporter-trace-otlp-http": "0.212.0",
  "@opentelemetry/instrumentation": "0.212.0",
  "@opentelemetry/instrumentation-http": "0.212.0",
  "@opentelemetry/resources": "2.5.1",
  "@opentelemetry/sdk-logs": "0.212.0",
  "@opentelemetry/sdk-metrics": "2.5.1",
  "@opentelemetry/sdk-node": "0.212.0",
  "@opentelemetry/sdk-trace-base": "2.5.1",
  "@opentelemetry/sdk-trace-node": "2.5.1",
  "@opentelemetry/semantic-conventions": "1.39.0"
}
```

**Contrib packages** (from `opentelemetry-js-contrib` repo — check latest compatible versions separately):

```json
{
  "@opentelemetry/host-metrics": "check latest",
  "@opentelemetry/instrumentation-aws-sdk": "check latest",
  "@opentelemetry/instrumentation-express": "check latest",
  "@opentelemetry/resource-detector-aws": "check latest"
}
```

These contrib packages are released independently and may lag behind. Verify they declare `@opentelemetry/api >=1.3.0 <1.10.0` as a peer dependency and work with SDK 2.x.

**Action items:**
1. Update all pinned versions as above.
2. Check the latest contrib package versions on npm that are compatible with SDK 2.5.1.
3. Audit `tracer.server.ts` for any deprecated API usage.
4. Build: `pnpm run build --filter webapp`
5. Run tests: `pnpm run test --filter webapp`

### Step 1.5: Fix `internal-packages/tracing`

This package has `@opentelemetry/api-logs` pinned at `0.52.1` — this is from the old SDK 1.x era and is incompatible with the rest of the monorepo that uses SDK 2.x packages.

Update `internal-packages/tracing/package.json`:

```json
{
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/api-logs": "0.212.0",
  "@opentelemetry/semantic-conventions": "1.39.0"
}
```

**Action items:**
1. Pin `semantic-conventions` exactly (remove the `^` range).
2. Jump `api-logs` from `0.52.1` to `0.212.0`. This is a large version jump — verify there are no breaking API changes in how this package uses the logs API. The `api-logs` public API surface is small (Logger, LogRecord types), so this should be straightforward.
3. Build packages that depend on this: `pnpm run build --filter @internal/run-engine`

### Step 1.6: Update reference projects

- `references/telemetry/package.json`: `@opentelemetry/resources` 2.2.0 → 2.5.1
- `references/nextjs-realtime/package.json`: `@opentelemetry/exporter-trace-otlp-http` ^0.57.0 → 0.212.0
- `references/d3-chat/package.json`: Update all otel deps to match target versions

---

## Phase 2: Add metrics support to `packages/core`

### Step 2.1: Add metrics dependencies to `packages/core`

Add these new dependencies to `packages/core/package.json`:

```json
{
  "@opentelemetry/sdk-metrics": "2.5.1",
  "@opentelemetry/exporter-metrics-otlp-http": "0.212.0"
}
```

### Step 2.2: Create metrics SDK module in core

Create a new file at `packages/core/src/v3/otel/metricsSDK.ts` (or extend `tracingSDK.ts`) to set up a `MeterProvider`:

**Recommended approach:** Extend `TracingSDK` to also manage a `MeterProvider`, similar to how it already manages `LoggerProvider` and `NodeTracerProvider`.

Key components needed:
- `MeterProvider` from `@opentelemetry/sdk-metrics`
- `PeriodicExportingMetricReader` from `@opentelemetry/sdk-metrics`
- `OTLPMetricExporter` from `@opentelemetry/exporter-metrics-otlp-http`

Example integration pattern (referencing the existing webapp setup at `apps/webapp/app/v3/tracer.server.ts`):

```typescript
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

// In TracingSDKConfig, add:
type TracingSDKConfig = {
  // ... existing fields ...
  metrics?: {
    enabled: boolean;
    exportIntervalMillis?: number; // default 60000
    exportTimeoutMillis?: number;  // default 30000
  };
};

// In TracingSDK constructor, add:
const metricExporter = new OTLPMetricExporter({
  url: `${config.url}/v1/metrics`,
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: config.metrics?.exportIntervalMillis ?? 60000,
  exportTimeoutMillis: config.metrics?.exportTimeoutMillis ?? 30000,
});

const meterProvider = new MeterProvider({
  resource: commonResources,
  readers: [metricReader],
});

// Expose getMeter
this.getMeter = meterProvider.getMeter.bind(meterProvider);
```

### Step 2.3: Export metrics types from core

Update `packages/core/src/v3/otel/index.ts` to re-export relevant metrics types so downstream consumers (SDK, CLI, webapp) can use them without adding direct dependencies on `@opentelemetry/sdk-metrics`.

### Step 2.4: Consider a new subpath export

Optionally, add a `@trigger.dev/core/v3/metrics` subpath export if the metrics surface area is large enough to warrant separation. Otherwise, exporting through `@trigger.dev/core/v3/otel` is fine.

---

## Phase 3: Verification

### Step 3.1: Build all packages

```bash
pnpm run build --filter @trigger.dev/core
pnpm run build --filter @trigger.dev/sdk
pnpm run build --filter trigger.dev
pnpm run build --filter webapp
```

### Step 3.2: Run tests

```bash
pnpm run test --filter @trigger.dev/core
pnpm run test --filter webapp
```

### Step 3.3: Verify no duplicate otel packages

After `pnpm install`, check for duplicate resolutions:

```bash
pnpm ls @opentelemetry/api --depth=3
pnpm ls @opentelemetry/sdk-trace-base --depth=3
```

Ensure there's only one version of each `@opentelemetry/*` package resolved across the monorepo. If there are duplicates, add `pnpm.overrides` in the root `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "@opentelemetry/api": "1.9.0",
      "@opentelemetry/resources": "2.5.1",
      "@opentelemetry/sdk-trace-base": "2.5.1"
    }
  }
}
```

### Step 3.4: Changeset

Since `@trigger.dev/core` is a public package, add a changeset:

```bash
pnpm run changeset:add
```

Select `@trigger.dev/core` and mark as **patch** (dependency upgrades with no public API changes). If the metrics API is also being exposed publicly, consider **minor**.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Deprecated `SemanticResourceAttributes` removed | Medium | Check 1.39.0 exports; replace with string literals if needed |
| `@internal/tracing` api-logs jump breaks types | Low | Small API surface; verify LogRecord/Logger type compat |
| Contrib packages not yet compatible with SDK 2.5.1 | Low | Contrib packages generally track core releases closely |
| Duplicate otel package resolutions in pnpm | Medium | Use `pnpm.overrides` to enforce single versions |
| OTLP exporter wire format changes | Very Low | OTLP proto format is stable; HTTP exporter format unchanged |

---

## SDK 2.x Breaking Changes to Watch For

From the [upgrade guide](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md):

1. **Minimum Node.js**: `^18.19.0 || >=20.6.0` (the repo already requires `>=18.20.0`, so this is fine)
2. **Minimum TypeScript**: `5.0.4` (verify the repo's TS version meets this)
3. **ES2022 target**: SDK packages now compile to ES2022
4. **Environment variable config**: `OTEL_*` env var reading was moved to `@opentelemetry/sdk-node` in `0.212.0`. Since the core package uses `TracingSDK` (not `sdk-node`), manual configuration via constructor options is unaffected
5. **`Resource` constructor deprecated**: Use `resourceFromAttributes()` instead (already used in `tracingSDK.ts`)

---

## Summary of New Packages to Add

| Package | Where | Version | Purpose |
|---------|-------|---------|---------|
| `@opentelemetry/sdk-metrics` | `packages/core` | 2.5.1 | MeterProvider, metric readers |
| `@opentelemetry/exporter-metrics-otlp-http` | `packages/core` | 0.212.0 | Export metrics via OTLP HTTP |

---

## Files That Need Code Changes

These files import from `@opentelemetry/semantic-conventions` and may need updates for deprecated exports:

1. `packages/core/src/v3/otel/tracingSDK.ts` — uses `SemanticResourceAttributes`, `SEMATTRS_HTTP_URL`
2. `packages/trigger-sdk/src/v3/**` — check for `SemanticResourceAttributes` usage
3. `packages/cli-v3/src/**` — check for deprecated imports
4. `apps/webapp/app/v3/tracer.server.ts` — uses semantic conventions
5. `internal-packages/tracing/src/**` — check for deprecated imports

All other changes are version bumps in `package.json` files only.
