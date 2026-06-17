---
name: trigger-cost-savings
description: >
  Analyze Trigger.dev tasks, schedules, and runs for cost optimization opportunities. Use when
  asked to reduce spend, optimize costs, audit usage, right-size machines, or review task
  efficiency. Combines static source analysis with live run analysis via the Trigger.dev MCP
  tools (list_runs, get_run_details, get_current_worker).
type: core
library: trigger.dev
sources:
  - docs/how-to-reduce-your-spend.mdx
  - docs/machines.mdx
  - docs/runs/max-duration.mdx
  - docs/queue-concurrency.mdx
  - docs/idempotency.mdx
  - docs/triggering.mdx
  - docs/errors-retrying.mdx
  - docs/limits.mdx
---

# Trigger.dev Cost Savings Analysis

Analyze task runs and configurations to find cost reduction opportunities. This skill pairs static source analysis with live run analysis via the Trigger.dev MCP server.

## Before you start: read the canonical guidance

The authoritative, version-pinned cost guidance ships beside this skill. Read it first so your recommendations match the installed SDK version:

- `@trigger.dev/sdk/docs/how-to-reduce-your-spend.mdx` — the canonical "reduce your spend" guide (machine sizing, idempotency de-dup, parallelism, retries, `maxDuration`, checkpointed waits, debounce).
- Supporting references: `@trigger.dev/sdk/docs/machines.mdx`, `runs/max-duration.mdx`, `queue-concurrency.mdx`, `idempotency.mdx`, `triggering.mdx` (debounce + batch), `errors-retrying.mdx` (`AbortTaskRunError`).

## Prerequisites: MCP tools

Live run analysis needs the **Trigger.dev MCP server**. Verify these tools are available:

- `list_runs` — list runs with filters (status, task, time period, machine size)
- `get_run_details` — get run logs, duration, and status
- `get_current_worker` — get registered tasks and their configurations

If they're not available, tell the user to install the MCP server:

```bash
npx trigger.dev@latest install-mcp
```

Without the MCP tools you can still do the static source analysis below; do not fabricate run data.

## Analysis workflow

### Step 1: Static analysis (source code)

Scan task files for:

1. **Oversized machines** — tasks on `large-1x`/`large-2x` without clear need.
2. **Missing `maxDuration`** — no execution-time limit (runaway-cost risk).
3. **Excessive retries** — `maxAttempts` > 5 without `AbortTaskRunError` for known-permanent failures.
4. **Missing debounce** — high-frequency triggers without debounce.
5. **Missing idempotency** — payment/critical tasks without idempotency keys.
6. **Polling instead of waits** — `setTimeout`/`setInterval`/sleep loops instead of `wait.for()`.
7. **Short waits** — `wait.for()` under 5 seconds (not checkpointed, wastes compute).
8. **Sequential instead of batch** — multiple `triggerAndWait()` calls that could be `batchTriggerAndWait()`.
9. **Over-scheduled crons** — schedules firing more often than needed.

### Step 2: Run analysis (requires MCP tools)

- **2a. Expensive tasks** — `list_runs` over `period: "30d"`/`"7d"`; find high total compute (duration × count), high failure rates, and large machines with short durations (over-provisioned).
- **2b. Failure patterns** — `list_runs` with `status: "FAILED"`/`"CRASHED"`; separate transient (retryable) from permanent; suggest `AbortTaskRunError` for the latter; estimate wasted retry compute.
- **2c. Machine utilization** — `get_run_details` on sample runs; if a `large-2x` task consistently runs in under a second, or is I/O-bound (API/DB), it's over-provisioned.
- **2d. Schedule frequency** — `get_current_worker` to list cron patterns; flag schedules that are too frequent for their purpose.

### Step 3: Generate recommendations

Present a prioritized report with estimated impact:

```markdown
## Cost Optimization Report

### High impact
1. **Right-size `process-images`** — currently `large-2x`, average run 2s. `small-2x` could cut this task's cost by ~16x.
   `machine: { preset: "small-2x" }`  // was "large-2x"

### Medium impact
2. **Debounce `sync-user-data`** — 847 runs/day, often bursty.
   `debounce: { key: \`user-${userId}\`, delay: "5s" }`

### Low impact / best practice
3. **Add `maxDuration` to `generate-report`** — no timeout configured.
   `maxDuration: 300`  // 5 minutes
```

## Machine preset costs (relative)

Larger machines cost proportionally more per second of compute:

| Preset | vCPU | RAM | Relative cost |
|--------|------|-----|---------------|
| micro | 0.25 | 0.25 GB | 0.25x |
| small-1x | 0.5 | 0.5 GB | 1x (baseline) |
| small-2x | 1 | 1 GB | 2x |
| medium-1x | 1 | 2 GB | 2x |
| medium-2x | 2 | 4 GB | 4x |
| large-1x | 4 | 8 GB | 8x |
| large-2x | 8 | 16 GB | 16x |

## Key principles

- **Waits > 5 seconds are free** — checkpointed, no compute charge.
- **Start small, scale up** — the default `small-1x` is right for most tasks.
- **I/O-bound tasks don't need big machines** — API calls and DB queries wait on the network.
- **Debounce saves the most on high-frequency tasks** — it consolidates bursts into single runs.
- **Idempotency prevents duplicate billed work** — especially for expensive operations.
- **`AbortTaskRunError` stops wasteful retries** — don't pay to retry permanent failures.

## Version

This skill is bundled inside `@trigger.dev/sdk` and read directly from `node_modules`, so it always matches your installed SDK version (see the adjacent `package.json`). The full cost documentation ships alongside it under `@trigger.dev/sdk/docs/`.
