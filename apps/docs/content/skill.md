---
name: trigger
description: Use when building durable background tasks, AI agents, webhooks, or
  long-running workflows in TypeScript. Reach for this skill when you need to
  create tasks that survive failures, handle retries, run on schedules, receive
  webhooks, or build multi-turn AI chat agents.
metadata:
  version: "1.0"
---

# Trigger.dev Skill

## Product summary

Trigger.dev is an open-source platform for building and running durable AI agents and workflows in TypeScript. Tasks run on Trigger.dev infrastructure (not inside your serverless functions), so they have no execution timeout and include built-in retries, queues, waits, full tracing, and elastic scaling. The core is Apache-2.0 licensed; use Trigger.dev Cloud or self-host.

**Key files and commands:**
- `trigger.config.ts` — project configuration (task directories, retries, build settings, telemetry)
- `/trigger` directory — where tasks and agents live
- `npx trigger.dev@latest init` — initialize a project
- `npx trigger.dev@latest dev` — run tasks locally
- `npx trigger.dev@latest deploy --env prod` — deploy to production
- `@trigger.dev/sdk` — main SDK package; `@trigger.dev/sdk/ai` for agents

**Primary docs:** https://trigger.dev/docs

## When to use

Use this skill when:
- Building background jobs, scheduled tasks, or long-running workflows that need to survive failures and retries
- Creating durable multi-turn AI chat agents with `chat.agent()` that persist across page refreshes and deploys
- Receiving webhooks from Stripe, GitHub, Linear, or 40+ other providers on hosted, verified endpoints
- Triggering tasks from your backend, frontend, or from inside other tasks
- Implementing human-in-the-loop workflows with approvals or waits
- Needing full observability: logs, traces, spans, and run history in the dashboard
- Building agents that need to pause and resume (waiting for external events, user approval, or time delays)

Do not use for: simple synchronous API calls, authentication setup, or dashboard-only operations.

## Quick reference

### Task definition
```ts
import { task } from "@trigger.dev/sdk";

export const myTask = task({
  id: "my-task",                    // Unique identifier
  retry: { maxAttempts: 3 },        // Retry config (optional)
  concurrency: { total: 1 },        // Concurrency limit (optional)
  machine: { preset: "large-1x" },  // CPU/RAM (optional)
  maxDuration: 300,                 // Max seconds (optional)
  run: async (payload, { ctx }) => {
    // Your code here; no timeout
    return { result: "data" };
  },
});
```

### Triggering tasks

| Context | Method | Type safety |
|---------|--------|-------------|
| Backend code | `tasks.trigger("task-id", payload)` | Type-only import |
| Backend code | `myTask.trigger(payload)` | Full import |
| Inside task | `childTask.trigger(payload)` | Full import |
| Inside task | `childTask.triggerAndWait(payload)` | Wait for result |
| Inside task | `childTask.batchTriggerAndWait([...])` | Fan-out pattern |
| Frontend | React hook `useTrigger()` | Type-safe |

### Webhook endpoints
```ts
import { webhooks, webhook } from "@trigger.dev/sdk";

export const stripe = webhooks.endpoint.define({
  id: "stripe",
  source: webhooks.stripe(),
});

export const fulfillOrder = webhook({
  id: "fulfill-order",
  endpoint: stripe,
  filter: "event.type == 'checkout.session.completed'",
  onEvent: async ({ event }) => { /* ... */ },
});
```

### Chat agents
```ts
import { chat } from "@trigger.dev/sdk/ai";
import { anthropic } from "@ai-sdk/anthropic";

export const supportAgent = chat.agent({
  id: "support-agent",
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model: anthropic("claude-sonnet-5-5"),
      messages,
      abortSignal: signal,
    }),
});
```

### CLI commands
| Command | Purpose |
|---------|---------|
| `trigger dev` | Run tasks locally; watches for changes |
| `trigger deploy --env prod` | Deploy to production |
| `trigger deploy --env staging` | Deploy to staging |
| `trigger tasks trigger <id>` | Trigger a task from CLI |
| `trigger env list` | List environment variables |
| `trigger login` | Authenticate with Trigger.dev |

### Configuration options (trigger.config.ts)
```ts
defineConfig({
  project: "<project-ref>",
  dirs: ["./trigger"],
  retries: { default: { maxAttempts: 3 } },
  machine: "large-1x",              // Default machine
  maxDuration: 300,                 // Default max duration
  ttl: "1h",                        // Default run TTL
  runtime: "node",                  // or "bun-1.4"
  build: {
    external: ["sharp", "wasm-pkg"],
    minify: false,
  },
  telemetry: {
    instrumentations: [/* ... */],
  },
});
```

## Decision guidance

### When to use X vs Y

| Scenario | Use | Why |
|----------|-----|-----|
| Task in same codebase | `myTask.trigger()` | Full type safety, direct import |
| Task in separate service | `tasks.trigger("id", payload)` | Avoids bundling task code |
| Need result immediately | `triggerAndWait()` | Blocks until child completes |
| Fan-out to many tasks | `batchTriggerAndWait()` | Parallel execution, single wait |
| Webhook from provider | `webhooks.endpoint.define()` | Hosted URL, verified, 40+ providers |
| Webhook from your app | `tasks.trigger()` from handler | Full control, no hosted endpoint |
| Chat with streaming | `chat.agent()` | Durable session, multi-turn |
| One-shot LLM call | `task()` with AI SDK | Simpler, no session overhead |
| Pause for approval | `wait.for()` or `waitpoints` | Doesn't consume compute while waiting |
| Scheduled work | `task()` with `scheduled: true` | Cron-like execution |

### Retry strategies

| Scenario | Config |
|----------|--------|
| Transient failures (network) | `maxAttempts: 3`, `factor: 1.8` |
| Critical task | `maxAttempts: 5`, `minTimeoutInMs: 500` |
| Rate-limited API | Use `wait.for()` inside task, not retries |
| No retries | `retry: { maxAttempts: 1 }` |

## Workflow

1. **Initialize the project**
   - Run `npx trigger.dev@latest init` in your project root
   - Choose your framework (Next.js, Remix, Node.js, etc.)
   - Select whether to set up MCP server for AI coding assistants
   - Verify `trigger.config.ts` and `/trigger` directory are created

2. **Define a task**
   - Create a file in `/trigger` (e.g., `email.ts`)
   - Export a `task()` with unique `id` and `run` function
   - Payload must be JSON-serializable; return value must be JSON-serializable
   - Add retry, concurrency, or machine options as needed

3. **Test locally**
   - Run `npx trigger.dev@latest dev` in one terminal
   - Trigger the task from your backend or dashboard
   - Watch logs in the terminal and dashboard
   - Fix errors and redeploy; dev mode rebuilds on save

4. **Trigger from your code**
   - Backend: `import { tasks } from "@trigger.dev/sdk"` and call `tasks.trigger()`
   - Inside task: import the task and call `myTask.trigger()` or `triggerAndWait()`
   - Set `TRIGGER_SECRET_KEY` environment variable with an API key (Trigger-only access)
   - For preview branches, also set `TRIGGER_PREVIEW_BRANCH`

5. **Deploy to production**
   - Run `npx trigger.dev@latest deploy --env prod`
   - CLI checks version mismatches and bundles code
   - Create a named API key in the Production environment
   - Set `TRIGGER_SECRET_KEY` in your production environment
   - Verify runs appear in the dashboard

6. **Monitor and debug**
   - Open the Trigger.dev dashboard to view runs
   - Click a run to see logs, traces, spans, and errors
   - Use `logger.info()` and `logger.error()` for custom logs
   - Check retry attempts and error messages
   - Use `ctx.run.id` to correlate with your app logs

## Common gotchas

- **Version mismatch:** CLI and `@trigger.dev/*` packages must match. Deploy will fail in CI if they don't. Add CLI to `devDependencies` and use `npm run deploy` to keep versions in sync.

- **Bundling task code in frontend:** Use `type`-only imports when calling `tasks.trigger()` from Next.js or other bundled code. Full imports pull task dependencies into your app bundle.

- **Payload serialization:** Return values and payloads must be JSON-serializable. Dates, functions, and circular references will fail. Convert Dates to ISO strings or pass them directly (SDK handles serialization).

- **No timeout in tasks:** Tasks run indefinitely by default. Set `maxDuration` on the task or in config to prevent runaway tasks. Waiting runs don't consume compute, so long waits are free.

- **Retries duplicate child tasks:** If a task retries and triggers a child task, the child will run again. Use `idempotencyKey` to deduplicate: `await childTask.trigger(payload, { idempotencyKey: await idempotencyKeys.create("key") })`.

- **Webhook secrets must be set:** Every webhook endpoint requires a signing secret before it accepts deliveries. Generate or set the secret in the dashboard before registering with the provider.

- **Chat agents default to no retries:** `chat.agent` defaults to `retry: { maxAttempts: 1 }`. Errors in a turn don't retry the whole conversation; the user sends another message instead.

- **Delayed runs use current version:** A run triggered with `delay: "1h"` will execute on the version deployed when it starts, not the version active when triggered.

- **Concurrency limits are per-task:** Setting `concurrency: { total: 1 }` on a task means only one run of that task executes at a time, not one run across all tasks.

- **Middleware and locals:** Use `tasks.middleware()` and `locals` to share state across lifecycle hooks. Deprecated `init` and `cleanup` hooks should be replaced with middleware.

- **Agent sessions are durable:** A `chat.agent` session survives page refreshes, deploys, and crashes. The same session ID resumes the conversation; don't create a new session for the same conversation.

## Verification checklist

Before submitting work:

- [ ] Task has a unique `id` across the project
- [ ] Payload and return value are JSON-serializable (no functions, circular refs, or raw Dates)
- [ ] `trigger.config.ts` specifies correct `dirs` and `project` ref
- [ ] `TRIGGER_SECRET_KEY` is set in backend environment (Trigger-only access)
- [ ] `TRIGGER_PREVIEW_BRANCH` is set if using preview branches
- [ ] Ran `npx trigger.dev@latest dev` locally and tested the task
- [ ] No version mismatches: `npm run deploy` uses same version as local dev
- [ ] Webhook endpoints have signing secrets set before registering with provider
- [ ] Chat agents use `chat.agent()` from `@trigger.dev/sdk/ai`, not `@trigger.dev/sdk`
- [ ] Retries are configured appropriately (not too aggressive for rate-limited APIs)
- [ ] Idempotency keys are used for child tasks inside retryable parents
- [ ] Logs use `logger.info()` or `console.log()`, not `console.error()` for non-errors
- [ ] Ran `npx trigger.dev@latest deploy --env prod` and verified runs in dashboard

## Resources

**Comprehensive page navigation:** https://trigger.dev/docs/llms.txt

**Critical documentation:**
- [Tasks overview](/tasks/overview) — how to define and structure tasks
- [Triggering](/triggering) — all patterns for triggering tasks from backend, frontend, and inside tasks
- [AI Agents overview](/ai-chat/overview) — durable multi-turn chat agents with `chat.agent()`
- [Webhooks overview](/webhooks/overview) — hosted endpoints and 40+ providers
- [Configuration](/config/config-file) — `trigger.config.ts` options and build extensions
- [Deployment](/deployment/overview) — prod, staging, and preview branch environments
- [CLI introduction](/cli-introduction) — all CLI commands and options

---

> For additional documentation and navigation, see: https://trigger.dev/docs/llms.txt
