import { AsyncLocalStorage } from "node:async_hooks";
import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import { context, propagation, ROOT_CONTEXT, type Context } from "@internal/tracing";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Logger } from "@trigger.dev/core/logger";
import { afterAll, beforeAll, expect } from "vitest";
import { WebhookJobQueue } from "./jobQueue.js";

function inMemoryMetrics() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter("webhook-engine-test"),
    /** Each data point of a metric: a counter's sum, or how many samples a histogram took. */
    async points(name: string) {
      await reader.forceFlush();
      const metric = exporter
        .getMetrics()
        .at(-1)
        ?.scopeMetrics.flatMap((scope) => scope.metrics)
        .find((m) => m.descriptor.name === name);
      return (metric?.dataPoints ?? [])
        .map((point) => ({
          attributes: point.attributes,
          value: typeof point.value === "number" ? point.value : point.value.count,
        }))
        .sort((a, b) => JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes)));
    },
    shutdown: () => provider.shutdown(),
  };
}

const TRACE_KEY = Symbol("webhook-test-trace");

beforeAll(() => {
  const storage = new AsyncLocalStorage<Context>();
  context.setGlobalContextManager({
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.apply(thisArg, args)),
    bind: (_ctx, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  });
  propagation.setGlobalPropagator({
    inject: (ctx, carrier, setter) => {
      const value = ctx.getValue(TRACE_KEY);
      if (typeof value === "string") setter.set(carrier, "x-test-trace", value);
    },
    extract: (ctx, carrier, getter) => {
      const value = getter.get(carrier, "x-test-trace");
      return typeof value === "string" ? ctx.setValue(TRACE_KEY, value) : ctx;
    },
    fields: () => ["x-test-trace"],
  });
});

afterAll(() => {
  context.disable();
  propagation.disable();
});

containerTestWithIsolatedRedisNoClickhouse(
  "a job runs in the trace context it was enqueued under and records queue time and outcomes",
  async ({ redisOptions }) => {
    const metrics = inMemoryMetrics();
    const seen: Array<unknown> = [];
    let calls = 0;
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      meter: metrics.meter,
      consumers: 1,
      tenantConcurrency: 1,
      consumerIntervalMs: 20,
      handlers: {
        deliver: async () => {
          seen.push(context.active().getValue(TRACE_KEY));
          if (++calls < 3) throw new Error("try again");
        },
        completeWaiters: async () => {},
      },
    });

    try {
      queue.start();
      await context.with(ROOT_CONTEXT.setValue(TRACE_KEY, "trace-from-ingest"), () =>
        queue.enqueue({
          id: "delivery_traced",
          environmentId: "env_traced",
          endpointId: "ep_traced",
          job: {
            job: "webhook.deliver",
            payload: { deliveryId: "delivery_traced", createdAt: new Date() },
          },
        })
      );

      const deadline = Date.now() + 30_000;
      while (calls < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(seen).toEqual(["trace-from-ingest", "trace-from-ingest", "trace-from-ingest"]);
      expect(await metrics.points("webhook_job_queue_time_ms")).toEqual([
        { attributes: { job: "webhook.deliver" }, value: 1 },
      ]);
      expect(await metrics.points("webhook_job_run_duration_ms")).toEqual([
        { attributes: { job: "webhook.deliver", outcome: "completed" }, value: 1 },
        { attributes: { job: "webhook.deliver", outcome: "retrying" }, value: 2 },
      ]);
    } finally {
      await queue.close();
      await metrics.shutdown();
    }
  },
  60_000
);

containerTestWithIsolatedRedisNoClickhouse(
  "an exhausted job is counted by what happened to it",
  async ({ redisOptions }) => {
    const metrics = inMemoryMetrics();
    let exhaustedCalls = 0;
    const queue = new WebhookJobQueue({
      redis: redisOptions,
      logger: new Logger("webhook-job-queue-test", "error"),
      meter: metrics.meter,
      consumers: 1,
      tenantConcurrency: 1,
      consumerIntervalMs: 20,
      exhaustedRecordDelayMs: 100,
      handlers: {
        deliver: async () => {
          throw new Error("database unavailable");
        },
        completeWaiters: async () => {},
        exhausted: async () => {
          if (++exhaustedCalls === 1) throw new Error("still unavailable");
        },
      },
    });

    try {
      queue.start();
      await queue.enqueue({
        id: "delivery_counted",
        environmentId: "env_counted",
        endpointId: "ep_counted",
        job: {
          job: "webhook.deliver",
          payload: { deliveryId: "delivery_counted", createdAt: new Date() },
        },
      });

      const deadline = Date.now() + 60_000;
      while (exhaustedCalls < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await metrics.points("webhook_job_exhausted_total")).toEqual([
        { attributes: { job: "webhook.deliver", result: "queued" }, value: 1 },
      ]);
      const runs = await metrics.points("webhook_job_run_duration_ms");
      expect(runs).toContainEqual({
        attributes: { job: "webhook.deliver", outcome: "exhausted" },
        value: 1,
      });
      expect(runs).toContainEqual({
        attributes: { job: "webhook.exhausted", outcome: "completed" },
        value: 1,
      });
    } finally {
      await queue.close();
      await metrics.shutdown();
    }
  },
  90_000
);
