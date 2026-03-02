---
title: "Logging, tracing & metrics"
description: "How to use the built-in logging, tracing, and metrics system."
---

![The run log](/images/run-log.png)

The run log shows you exactly what happened in every run of your tasks. It is comprised of logs, traces and spans.

## Logs

You can use `console.log()`, `console.error()`, etc as normal and they will be shown in your run log. This is the standard function so you can use it as you would in any other JavaScript or TypeScript code. Logs from any functions/packages will also be shown.

### logger

We recommend that you use our `logger` object which creates structured logs. Structured logs will make it easier for you to search the logs to quickly find runs.

```ts /trigger/logging.ts
import { task, logger } from "@trigger.dev/sdk";

export const loggingExample = task({
  id: "logging-example",
  run: async (payload: { data: Record<string, string> }) => {
    //the first parameter is the message, the second parameter must be a key-value object (Record<string, unknown>)
    logger.debug("Debug message", payload.data);
    logger.log("Log message", payload.data);
    logger.info("Info message", payload.data);
    logger.warn("You've been warned", payload.data);
    logger.error("Error message", payload.data);
  },
});
```

## Tracing and spans

Tracing is a way to follow the flow of your code. It's very useful for debugging and understanding how your code is working, especially with long-running or complex tasks.

Trigger.dev uses OpenTelemetry tracing under the hood. With automatic tracing for many things like task triggering, task attempts, HTTP requests, and more.

| Name          | Description                      |
| :------------ | :------------------------------- |
| Task triggers | Task triggers                    |
| Task attempts | Task attempts                    |
| HTTP requests | HTTP requests made by your code. |

### Adding instrumentations

![The run log](/images/auto-instrumentation.png)

You can [add instrumentations](/config/config-file#instrumentations). The Prisma one above will automatically trace all Prisma queries.

### Add custom traces

If you want to add custom traces to your code, you can use the `logger.trace` function. It will create a new OTEL trace and you can set attributes on it.

```ts
import { logger, task } from "@trigger.dev/sdk";

export const customTrace = task({
  id: "custom-trace",
  run: async (payload) => {
    //you can wrap code in a trace, and set attributes
    const user = await logger.trace("fetch-user", async (span) => {
      span.setAttribute("user.id", "1");

      //...do stuff

      //you can return a value
      return {
        id: "1",
        name: "John Doe",
        fetchedAt: new Date(),
      };
    });

    const usersName = user.name;
  },
});
```

## Metrics

Trigger.dev collects system and runtime metrics automatically for deployed tasks, and provides an API for recording custom metrics using OpenTelemetry.

You can view metrics in the [Dashboards](/observability/dashboards), query them with [TRQL](/observability/query), and export them to external services via [telemetry exporters](/config/config-file#telemetry-exporters).

### Custom metrics API

Import `otel` from `@trigger.dev/sdk` and use the standard OpenTelemetry Metrics API to create custom instruments.

Create instruments **at module level** (outside the task `run` function) so they are reused across runs:

```ts /trigger/metrics.ts
import { task, logger, otel } from "@trigger.dev/sdk";

// Create a meter — instruments are created once at module level
const meter = otel.metrics.getMeter("my-app");

const itemsProcessed = meter.createCounter("items.processed", {
  description: "Total number of items processed",
  unit: "items",
});

const itemDuration = meter.createHistogram("item.duration", {
  description: "Time spent processing each item",
  unit: "ms",
});

const queueDepth = meter.createUpDownCounter("queue.depth", {
  description: "Current queue depth",
  unit: "items",
});

export const processQueue = task({
  id: "process-queue",
  run: async (payload: { items: string[] }) => {
    queueDepth.add(payload.items.length);

    for (const item of payload.items) {
      const start = performance.now();

      // ... process item ...

      const elapsed = performance.now() - start;

      itemsProcessed.add(1, { "item.type": "order" });
      itemDuration.record(elapsed, { "item.type": "order" });
      queueDepth.add(-1);
    }

    logger.info("Queue processed", { count: payload.items.length });
  },
});
```

#### Available instrument types

| Instrument | Method | Use case |
| :--- | :--- | :--- |
| Counter | `meter.createCounter()` | Monotonically increasing values (items processed, requests sent) |
| Histogram | `meter.createHistogram()` | Distributions of values (durations, sizes) |
| UpDownCounter | `meter.createUpDownCounter()` | Values that go up and down (queue depth, active connections) |

All instruments accept optional attributes when recording values. Attributes let you break down metrics by dimension (e.g., by item type, status, or region).

### Automatic system and runtime metrics

Trigger.dev automatically collects the following metrics for deployed tasks. No configuration is needed. Requires SDK version **4.4.1 or later**.

| Metric name | Type | Unit | Description |
| :--- | :--- | :--- | :--- |
| `process.cpu.utilization` | gauge | ratio | Process CPU usage (0-1) |
| `process.cpu.time` | counter | seconds | CPU time consumed |
| `process.memory.usage` | gauge | bytes | Process memory usage |
| `nodejs.event_loop.utilization` | gauge | ratio | Event loop utilization (0-1) |
| `nodejs.event_loop.delay.p95` | gauge | seconds | Event loop delay p95 |
| `nodejs.event_loop.delay.max` | gauge | seconds | Event loop delay max |
| `nodejs.heap.used` | gauge | bytes | V8 heap used |
| `nodejs.heap.total` | gauge | bytes | V8 heap total |

<Note>
In dev mode (`trigger dev`), only `process.*` and custom metrics are available.
</Note>

### Context attributes

All metrics (both automatic and custom) are tagged with run context so you can filter and group them:

- `run_id` — the run that produced the metric
- `task_identifier` — the task slug
- `attempt_number` — the attempt number
- `machine_name` — the machine preset (e.g., `small-1x`)
- `worker_version` — the deployed worker version
- `environment_type` — `PRODUCTION`, `STAGING`, `DEVELOPMENT`, or `PREVIEW`

### Querying metrics

Use [TRQL](/observability/query) to query metrics data. For example, to see average CPU utilization over time:

```sql
SELECT
  timeBucket(),
  avg(value) AS avg_cpu
FROM metrics
WHERE metric_name = 'process.cpu.utilization'
GROUP BY timeBucket
ORDER BY timeBucket
LIMIT 1000
```

See the [Query page](/observability/query#metrics-table-columns) for the full `metrics` table schema.

### Exporting metrics

You can send metrics to external observability services (Axiom, Honeycomb, Datadog, etc.) by configuring [telemetry exporters](/config/config-file#telemetry-exporters) in your `trigger.config.ts`.
