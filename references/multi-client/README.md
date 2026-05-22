# multi-client reference

Exercises `new TriggerClient(...)` — the explicit, per-instance management
client introduced alongside the global `configure()` API. Useful when a
single process needs to talk to multiple projects, environments, or
preview branches without globally mutating SDK state.

## What's inside

- `src/trigger/echo.ts` — a trivial task that returns its payload (the
  trigger target for the external scripts and the fan-out task).
- `src/trigger/fanOut.ts` — runs inside a task and triggers `echo`
  through two different `TriggerClient` instances in parallel.
- `src/external/main.ts` — external Node script. Two clients with
  different secrets (and optionally different preview branches),
  triggers `echo` sequentially and concurrently, logs every outgoing
  request's `authorization` + `x-trigger-branch` headers.
- `src/external/isolation.ts` — interleaves the global `configure()`
  API and an instance call, asserts via the captured fetches that
  neither side leaks into the other.

## Running locally

Boot the webapp (`pnpm dev --filter webapp`) and `trigger dev` in this
workspace as usual, then run the scripts against `http://localhost:3030`:

```bash
TRIGGER_API_URL=http://localhost:3030 \
TRIGGER_PRIMARY_KEY=tr_dev_... \
TRIGGER_SECONDARY_KEY=tr_dev_... \
TRIGGER_SECONDARY_BRANCH=signup-flow \
pnpm trigger:external
```

```bash
TRIGGER_API_URL=http://localhost:3030 \
TRIGGER_GLOBAL_KEY=tr_dev_... \
TRIGGER_INSTANCE_KEY=tr_dev_... \
TRIGGER_INSTANCE_BRANCH=preview-x \
pnpm trigger:isolation
```

The fan-out task is exercised by triggering it through the dashboard or
via the Trigger MCP after setting `TRIGGER_FAN_OUT_PRIMARY_KEY` and
`TRIGGER_FAN_OUT_SECONDARY_KEY` in the dev env.
