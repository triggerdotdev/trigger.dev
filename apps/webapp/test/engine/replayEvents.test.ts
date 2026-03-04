import { describe, expect, vi } from "vitest";

// Mock the db prisma client (required for webapp service imports)
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IOPacket } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { ClickHouse } from "@internal/clickhouse";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  TagValidationParams,
  TracedEventSpan,
  TraceEventConcern,
  TriggerRacepoints,
  TriggerRacepointSystem,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { type TriggerFn } from "../../app/v3/services/events/publishEvent.server";
import { ReplayEventsService } from "../../app/v3/services/events/replayEvents.server";

vi.setConfig({ testTimeout: 120_000 });

class MockPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return {
      data: JSON.stringify(request.body.payload),
      dataType: "application/json",
    };
  }
}

class MockTriggerTaskValidator implements TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    return { ok: true };
  }
}

class MockTraceEventConcern implements TraceEventConcern {
  async traceRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceDebouncedRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      debounceKey: string;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }
}

function createEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function createTriggerTaskService(prisma: any, engine: RunEngine) {
  const traceEventConcern = new MockTraceEventConcern();
  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, traceEventConcern),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern,
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024,
  });
}

function buildTriggerFn(prisma: any, engine: RunEngine): TriggerFn {
  const svc = createTriggerTaskService(prisma, engine);
  return async (taskId, environment, body, options) => {
    return svc.call({
      taskId,
      environment,
      body,
      options,
    });
  };
}

/** Format a Date for ClickHouse DateTime64(3) — strip trailing 'Z' from ISO string */
function toClickHouseDateTime(date: Date): string {
  return date.toISOString().replace("Z", "");
}

/** Insert test events directly into ClickHouse event_log_v1 */
async function insertTestEvents(
  clickhouse: ClickHouse,
  events: Array<{
    event_id: string;
    event_type: string;
    payload: unknown;
    published_at: Date;
    environment_id: string;
    project_id: string;
    organization_id: string;
    tags?: string[];
  }>
) {
  const insert = clickhouse.eventLog.insert;
  for (const event of events) {
    const [err] = await insert({
      event_id: event.event_id,
      event_type: event.event_type,
      payload: JSON.stringify(event.payload),
      payload_type: "application/json",
      published_at: toClickHouseDateTime(event.published_at),
      environment_id: event.environment_id,
      project_id: event.project_id,
      organization_id: event.organization_id,
      publisher_run_id: "",
      idempotency_key: "",
      tags: event.tags ?? [],
      metadata: "{}",
      fan_out_count: 1,
    });
    if (err) {
      throw new Error(`Failed to insert test event: ${err.message}`);
    }
  }
}

describe("ReplayEventsService", () => {
  containerTest(
    "replay returns 0 when no events exist in date range",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const service = new ReplayEventsService(clickhouse, prisma);

        const result = await service.call({
          eventSlug: "order.created",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-01-02"),
        });

        expect(result.replayedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(result.dryRun).toBe(false);
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );

  containerTest(
    "dry run returns count without actually publishing",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Insert test events into ClickHouse
        await insertTestEvents(clickhouse, [
          {
            event_id: "evt_dry_1",
            event_type: "order.created",
            payload: { orderId: "o1" },
            published_at: new Date("2026-01-15T10:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
          },
          {
            event_id: "evt_dry_2",
            event_type: "order.created",
            payload: { orderId: "o2" },
            published_at: new Date("2026-01-15T11:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
          },
        ]);

        const service = new ReplayEventsService(clickhouse, prisma);

        const result = await service.call({
          eventSlug: "order.created",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-02-01"),
          dryRun: true,
        });

        expect(result.dryRun).toBe(true);
        expect(result.replayedCount).toBe(2);
        expect(result.skippedCount).toBe(0);
        expect(result.runs).toBeUndefined();
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );

  containerTest(
    "replay re-publishes events and triggers subscriber runs",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "order-handler");

        // Create event definition and subscription
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "order-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        // Insert test events into ClickHouse
        await insertTestEvents(clickhouse, [
          {
            event_id: "evt_replay_1",
            event_type: "order.created",
            payload: { orderId: "o1", amount: 100 },
            published_at: new Date("2026-01-15T10:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
          },
        ]);

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new ReplayEventsService(clickhouse, prisma, triggerFn);

        const result = await service.call({
          eventSlug: "order.created",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-02-01"),
        });

        expect(result.replayedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(result.dryRun).toBe(false);
        expect(result.runs).toHaveLength(1);
        expect(result.runs![0]!.taskIdentifier).toBe("order-handler");
        expect(result.runs![0]!.sourceEventId).toBe("evt_replay_1");
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );

  containerTest(
    "replay applies EventFilter to narrow events",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "filtered-handler");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "filtered-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        // Insert events: one matches filter, one does not
        await insertTestEvents(clickhouse, [
          {
            event_id: "evt_f1",
            event_type: "order.created",
            payload: { status: "paid", amount: 500 },
            published_at: new Date("2026-01-15T10:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
          },
          {
            event_id: "evt_f2",
            event_type: "order.created",
            payload: { status: "pending", amount: 50 },
            published_at: new Date("2026-01-15T11:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
          },
        ]);

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new ReplayEventsService(clickhouse, prisma, triggerFn);

        const result = await service.call({
          eventSlug: "order.created",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-02-01"),
          filter: { status: ["paid"] },
        });

        expect(result.replayedCount).toBe(1);
        expect(result.skippedCount).toBe(1);
        expect(result.runs).toHaveLength(1);
        expect(result.runs![0]!.sourceEventId).toBe("evt_f1");
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );

  containerTest(
    "replay skips events with malformed payloads",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "bad-payload-handler");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "malformed.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "bad-payload-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        // Insert one good and one malformed event directly via raw ClickHouse client
        const insert = clickhouse.eventLog.insert;
        await insert({
          event_id: "evt_good",
          event_type: "malformed.event",
          payload: JSON.stringify({ valid: true }),
          payload_type: "application/json",
          published_at: toClickHouseDateTime(new Date("2026-01-15T10:00:00Z")),
          environment_id: env.id,
          project_id: env.projectId,
          organization_id: env.organizationId,
          publisher_run_id: "",
          idempotency_key: "",
          tags: [],
          metadata: "{}",
          fan_out_count: 1,
        });
        await insert({
          event_id: "evt_bad",
          event_type: "malformed.event",
          payload: "NOT_VALID_JSON{{{",
          payload_type: "application/json",
          published_at: toClickHouseDateTime(new Date("2026-01-15T11:00:00Z")),
          environment_id: env.id,
          project_id: env.projectId,
          organization_id: env.organizationId,
          publisher_run_id: "",
          idempotency_key: "",
          tags: [],
          metadata: "{}",
          fan_out_count: 1,
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new ReplayEventsService(clickhouse, prisma, triggerFn);

        const result = await service.call({
          eventSlug: "malformed.event",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-02-01"),
        });

        // The good event should replay, the bad one should be caught by the try/catch
        expect(result.replayedCount).toBe(1);
        expect(result.runs).toHaveLength(1);
        expect(result.runs![0]!.sourceEventId).toBe("evt_good");
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );

  containerTest(
    "replay preserves tags from original events",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = createEngine(prisma, redisOptions);
      const clickhouse = new ClickHouse({ url: clickhouseContainer.getConnectionUrl() });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "tagged-handler");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "tagged.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "tagged-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        await insertTestEvents(clickhouse, [
          {
            event_id: "evt_tagged_1",
            event_type: "tagged.event",
            payload: { data: "hello" },
            published_at: new Date("2026-01-15T10:00:00Z"),
            environment_id: env.id,
            project_id: env.projectId,
            organization_id: env.organizationId,
            tags: ["region:us", "priority:high"],
          },
        ]);

        // Use a mock triggerFn to capture what gets passed through
        let capturedTags: string[] | undefined;
        const mockTriggerFn: TriggerFn = async (taskId, environment, body, options) => {
          capturedTags = body.options?.tags as string[] | undefined;
          return {
            run: {
              id: "run_internal_1",
              friendlyId: "run_mock_1",
            },
          };
        };

        const service = new ReplayEventsService(clickhouse, prisma, mockTriggerFn);

        const result = await service.call({
          eventSlug: "tagged.event",
          environment: env,
          from: new Date("2026-01-01"),
          to: new Date("2026-02-01"),
        });

        expect(result.replayedCount).toBe(1);
        expect(result.runs).toHaveLength(1);
        expect(result.runs![0]!.sourceEventId).toBe("evt_tagged_1");
        // Verify tags were passed through to the trigger function
        expect(capturedTags).toEqual(["region:us", "priority:high"]);
      } finally {
        await engine.quit();
        await clickhouse.close();
      }
    }
  );
});
