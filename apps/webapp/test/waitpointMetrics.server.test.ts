import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import {
  containerTestWithIsolatedRedis,
  redisContainer,
  redisOptions as redisOptionsFixture,
} from "@internal/testcontainers";
import { metrics, trace } from "@internal/tracing";
import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { describe, expect, vi } from "vitest";
import { Redis, type RedisOptions } from "ioredis";

// Use real client connection lifecycles instead of the webapp's import-time singleton stubs.
vi.unmock("ioredis");

// The store gets its own Redis so its command counters see only waitpoint store traffic.
const containerTest = containerTestWithIsolatedRedis.extend<{ storeRedisOptions: RedisOptions }>({
  storeRedisOptions: ({ network, task }, use) =>
    redisContainer({ network, task } as Parameters<typeof redisContainer>[0], (container) =>
      redisOptionsFixture({ redisContainer: container }, use)
    ),
});

describe("waitpointMetrics.server", () => {
  // Catches: waitpoint metrics exporting organization ids, or MemoryDB commands and extra flag lookups while the store is disabled.
  containerTest(
    "production waitpoint metrics export without off-path cluster commands",
    async ({ prisma, redisOptions, storeRedisOptions }) => {
      const received: Buffer[] = [];
      const receiver = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        received.push(request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
      await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
      const port = (receiver.address() as AddressInfo).port;
      const memory = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
      const provider = new MeterProvider({
        readers: [
          new PeriodicExportingMetricReader({ exporter: memory, exportIntervalMillis: 3_600_000 }),
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `http://127.0.0.1:${port}/v1/metrics` }),
            exportIntervalMillis: 3_600_000,
          }),
        ],
      });
      metrics.setGlobalMeterProvider(provider);
      const meter = provider.getMeter("waitpoint-production-test");
      const storeClient = new Redis(storeRedisOptions);
      const observer = new Redis(storeRedisOptions);
      // Observe the server's actual command counters without patching the Redis client.
      // INFO is the observer's own command and is excluded from the comparison.
      const commandCounts = async () => {
        const counts: Record<string, number> = {};
        for (const line of (await observer.info("commandstats")).split("\n")) {
          const match = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
          if (match && match[1] !== "info") counts[match[1]!] = Number(match[2]);
        }
        return counts;
      };
      let beforeCommands = await commandCounts();
      const connection = { store: new WaitpointStoreCoordinator({ client: storeClient, meter }) };
      let enabled = false;
      let flagLookups = 0;
      let engine: RunEngine | undefined;
      try {
        engine = new RunEngine({
          tracer: trace.getTracer("waitpoint-production-test"),
          prisma,
          meter,
          logLevel: "error",
          worker: { redis: redisOptions, disabled: true, workers: 1, tasksPerWorker: 1 },
          queue: {
            redis: redisOptions,
            masterQueueConsumersDisabled: true,
            ttlSystem: { disabled: true },
          },
          runLock: { redis: redisOptions },
          machines: {
            defaultMachine: "small-1x",
            machines: {
              "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
            },
            baseCostInCents: 0.0001,
          },
          waitpointStore: connection.store,
          waitpointFanoutStore: connection.store,
          waitpointRouting: { store: new StoreWaitpointCoordinator({ store: connection.store }) },
          waitpointStoreEnabled: () => {
            flagLookups++;
            return enabled;
          },
        });
        const payload = { waitpointId: "w_metrics_native", organizationId: "org_metrics_private" };
        const worker = (
          engine as unknown as {
            worker: {
              enqueue: (args: unknown) => Promise<unknown>;
              jobs: {
                deliverWaitpointFanout: (args: { payload: typeof payload }) => Promise<void>;
              };
            };
          }
        ).worker;
        const latest = () => {
          const exports = memory.getMetrics();
          return exports[exports.length - 1]!.scopeMetrics.flatMap((scope) => scope.metrics);
        };
        await worker.jobs.deliverWaitpointFanout({ payload });
        await provider.forceFlush();
        expect(flagLookups).toBe(1);
        expect(await commandCounts()).toEqual(beforeCommands);
        expect(latest().some((metric) => metric.descriptor.name.startsWith("waitpoint."))).toBe(
          false
        );
        enabled = true;
        const now = new Date().toISOString();
        await connection.store.createIfAbsent({
          record: {
            id: payload.waitpointId,
            friendlyId: `waitpoint_${payload.waitpointId}`,
            type: "RUN",
            environmentId: "env_metrics",
            projectId: "proj_metrics",
            completedByTaskRunId: "child_metrics",
            createdAt: now,
            updatedAt: now,
            tags: [],
            userProvidedIdempotencyKey: false,
          },
          status: "PENDING",
        });
        const registration = {
          runId: "parent_metrics",
          blockId: "block_metrics",
          organizationId: payload.organizationId,
          edges: [{ waitpointId: payload.waitpointId, createdAt: now, type: "RUN" as const }],
        };
        const absorbed = await connection.store.absorbBlockers(registration);
        expect(absorbed.outcome).toBe("absorbed");
        if (absorbed.outcome !== "absorbed") throw new Error("Fixture block refused");
        await connection.store.registerAndDeliver({ ...registration, absorbed });
        await connection.store.complete({
          waitpointId: payload.waitpointId,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: { inline: "42" },
          },
        });
        await worker.enqueue({
          id: `deliverWaitpointFanout:${payload.waitpointId}`,
          job: "deliverWaitpointFanout",
          payload,
          availableAt: new Date(Date.now() - 1_000),
        });
        await worker.jobs.deliverWaitpointFanout({ payload });
        expect(await commandCounts()).not.toEqual(beforeCommands);
        beforeCommands = await commandCounts();
        await provider.forceFlush();
        expect(await commandCounts()).toEqual(beforeCommands);
        const data = latest();
        for (const name of [
          "waitpoint.store.completions",
          "waitpoint.store.registrations",
          "waitpoint.store.run_deliveries",
          "waitpoint.fanout.watchers_delivered",
          "waitpoint.fanout.pages_processed",
        ]) {
          const metric = data.find((metric) => metric.descriptor.name === name);
          expect(metric?.dataPoints.reduce((sum, point) => sum + Number(point.value), 0)).toBe(1);
          expect(received.some((body) => body.includes(Buffer.from(name)))).toBe(true);
        }
        expect(
          data.find((metric) => metric.descriptor.name === "waitpoint.fanout.delivery_latency")
            ?.dataPoints[0]?.value
        ).toMatchObject({ count: 1 });
        expect(
          received.some((body) => body.includes(Buffer.from("waitpoint.fanout.delivery_latency")))
        ).toBe(true);
        for (const name of [
          "redis_worker.queue.size",
          "redis_worker.queue.oldest_message_age",
          "redis_worker.queue.dead_letter_size",
        ]) {
          const point = data
            .filter((metric) => metric.dataPointType === DataPointType.GAUGE)
            .filter((metric) => metric.descriptor.name === name)
            .flatMap((metric) => metric.dataPoints)
            .find((point) => point.attributes.worker_name === "run-engine-worker");
          expect(point).toBeDefined();
          if (name !== "redis_worker.queue.dead_letter_size")
            expect(Number(point!.value)).toBeGreaterThan(0);
          expect(received.some((body) => body.includes(Buffer.from(name)))).toBe(true);
        }
        expect(
          data.some((metric) =>
            [
              "waitpoint.fanout.backlog",
              "waitpoint.fanout.backlog_oldest_age",
              "waitpoint.fanout.quarantine_depth",
            ].includes(metric.descriptor.name)
          )
        ).toBe(false);
        for (const metric of data.filter((metric) =>
          metric.descriptor.name.startsWith("waitpoint.")
        )) {
          for (const point of metric.dataPoints)
            expect(Object.values(point.attributes)).not.toContain(payload.organizationId);
        }
        enabled = false;
        const beforeRollback = flagLookups;
        beforeCommands = await commandCounts();
        await worker.jobs.deliverWaitpointFanout({ payload });
        await provider.forceFlush();
        await provider.forceFlush();
        expect(flagLookups).toBe(beforeRollback + 1);
        expect(await commandCounts()).toEqual(beforeCommands);
      } finally {
        await provider.shutdown();
        await engine?.quit();
        metrics.disable();
        await storeClient.quit();
        await observer.quit();
        await new Promise<void>((resolve, reject) =>
          receiver.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
});
