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
import {
  PublishEventService,
  EventPublishRateLimitError,
  type TriggerFn,
} from "../../app/v3/services/events/publishEvent.server";
import { InMemoryEventRateLimitChecker } from "../../app/v3/services/events/eventRateLimiter.server";
import { ServiceValidationError } from "../../app/v3/services/common.server";

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

/** Build a TriggerFn that delegates to RunEngineTriggerTaskService */
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

describe("PublishEventService", () => {
  containerTest(
    "publish event with no subscribers returns 0 runs",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Create an event definition with no subscriptions
        await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("order.created", env, { orderId: "123" });

        expect(result).toBeDefined();
        expect(result.eventId).toBeDefined();
        expect(result.eventId).toMatch(/^evt_/);
        expect(result.runs).toHaveLength(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publish event with 3 subscribers creates 3 runs",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIds = ["send-email", "update-inventory", "notify-slack"];

        const { worker } = await setupBackgroundWorker(engine, env, taskIds);

        // Create event definition
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Create subscriptions for all 3 tasks
        for (const taskSlug of taskIds) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
            },
          });
        }

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("order.created", env, { orderId: "123" });

        expect(result).toBeDefined();
        expect(result.eventId).toMatch(/^evt_/);
        expect(result.runs).toHaveLength(3);

        // Verify each task got triggered
        const triggeredTasks = result.runs.map((r) => r.taskIdentifier).sort();
        expect(triggeredTasks).toEqual(["notify-slack", "send-email", "update-inventory"]);

        // Verify runs exist in DB
        for (const run of result.runs) {
          const dbRun = await prisma.taskRun.findFirst({
            where: { friendlyId: run.runId },
          });
          expect(dbRun).toBeDefined();
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publish event that does not exist throws 404",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        await expect(
          service.call("nonexistent.event", env, { data: "test" })
        ).rejects.toThrow(ServiceValidationError);

        await expect(
          service.call("nonexistent.event", env, { data: "test" })
        ).rejects.toThrow('Event "nonexistent.event" not found');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "disabled subscription does not receive event",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, ["active-task", "disabled-task"]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "user.updated",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Active subscription
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "active-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        // Disabled subscription
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "disabled-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: false,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("user.updated", env, { userId: "u1" });

        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("active-task");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "error in one trigger does not affect others",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, ["good-task", "failing-task"]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.shipped",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "failing-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "good-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        // Build a trigger function that fails for "failing-task"
        const realTriggerFn = buildTriggerFn(prisma, engine);
        const failingTriggerFn: TriggerFn = async (taskId, environment, body, options) => {
          if (taskId === "failing-task") {
            throw new Error("Simulated trigger failure");
          }
          return realTriggerFn(taskId, environment, body, options);
        };

        const service = new PublishEventService(prisma, failingTriggerFn);

        const result = await service.call("order.shipped", env, { trackingId: "T123" });

        // Only the good task should have a run; the failing one is silently dropped
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("good-task");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publish event with schema rejects invalid payload",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Create event with a JSON Schema
        await prisma.eventDefinition.create({
          data: {
            slug: "typed.event",
            version: "1.0",
            projectId: env.projectId,
            schema: {
              type: "object",
              properties: {
                orderId: { type: "string" },
                amount: { type: "number" },
              },
              required: ["orderId", "amount"],
            },
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Invalid payload (orderId is number instead of string, amount is missing)
        await expect(
          service.call("typed.event", env, { orderId: 123 })
        ).rejects.toThrow(ServiceValidationError);

        await expect(
          service.call("typed.event", env, { orderId: 123 })
        ).rejects.toThrow("Payload validation failed");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publish event with schema accepts valid payload",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "handler");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "typed.event.ok",
            version: "1.0",
            projectId: env.projectId,
            schema: {
              type: "object",
              properties: {
                orderId: { type: "string" },
                amount: { type: "number" },
              },
              required: ["orderId", "amount"],
            },
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Valid payload
        const result = await service.call("typed.event.ok", env, {
          orderId: "ord-123",
          amount: 42.50,
        });

        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("handler");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publish event without schema skips validation",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Create event WITHOUT schema
        await prisma.eventDefinition.create({
          data: {
            slug: "untyped.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Any payload should work
        const result = await service.call("untyped.event", env, { anything: true, foo: [1, 2] });

        expect(result).toBeDefined();
        expect(result.eventId).toMatch(/^evt_/);
        expect(result.runs).toHaveLength(0); // no subscribers
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "content-based filter skips non-matching subscribers",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, [
          "high-value-handler",
          "all-orders-handler",
        ]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.placed",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Subscription with filter: only orders with amount > 1000
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "high-value-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            filter: { amount: [{ $gt: 1000 }] },
          },
        });

        // Subscription without filter: gets all events
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "all-orders-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Low-value order — only all-orders-handler should get it
        const result = await service.call("order.placed", env, { orderId: "o1", amount: 50 });

        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("all-orders-handler");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "content-based filter allows matching subscribers",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, [
          "high-value-handler",
          "all-orders-handler",
        ]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.placed.v2",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Filter: amount > 1000
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "high-value-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            filter: { amount: [{ $gt: 1000 }] },
          },
        });

        // No filter
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "all-orders-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // High-value order — both handlers should get it
        const result = await service.call("order.placed.v2", env, { orderId: "o2", amount: 5000 });

        expect(result.runs).toHaveLength(2);
        const taskIds = result.runs.map((r) => r.taskIdentifier).sort();
        expect(taskIds).toEqual(["all-orders-handler", "high-value-handler"]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "complex filter with multiple conditions",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, [
          "vip-gold-handler",
          "catch-all",
        ]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "customer.action",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Complex filter: status = "active" AND tier = "gold"
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "vip-gold-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            filter: { status: ["active"], tier: ["gold"] },
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "catch-all",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Matches both conditions — both handlers triggered
        const result1 = await service.call("customer.action", env, {
          customerId: "c1",
          status: "active",
          tier: "gold",
        });
        expect(result1.runs).toHaveLength(2);

        // Does not match (wrong tier) — only catch-all triggered
        const result2 = await service.call("customer.action", env, {
          customerId: "c2",
          status: "active",
          tier: "silver",
        });
        expect(result2.runs).toHaveLength(1);
        expect(result2.runs[0].taskIdentifier).toBe("catch-all");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "wildcard pattern order.* matches order.created",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "order-watcher");

        // Create the event definition for order.created
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Create a pattern-based subscription: order.*
        // It still needs an eventDefinitionId (we use a "placeholder" definition)
        const patternEventDef = await prisma.eventDefinition.create({
          data: {
            slug: "pattern:order.*",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: patternEventDef.id } },
            taskSlug: "order-watcher",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            pattern: "order.*",
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // order.created should match order.*
        const result = await service.call("order.created", env, { orderId: "o1" });
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("order-watcher");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "wildcard pattern order.* does NOT match order.status.changed",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "order-watcher");

        // Create the event definition for order.status.changed
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.status.changed",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Pattern subscription: order.*
        const patternEventDef = await prisma.eventDefinition.create({
          data: {
            slug: "pattern:order.*",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: patternEventDef.id } },
            taskSlug: "order-watcher",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            pattern: "order.*",
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // order.status.changed should NOT match order.* (too many levels)
        const result = await service.call("order.status.changed", env, { orderId: "o1" });
        expect(result.runs).toHaveLength(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "wildcard pattern order.# matches multi-level slugs",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "order-all-handler");

        // Create event definitions
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.status.changed",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Pattern subscription: order.#
        const patternEventDef = await prisma.eventDefinition.create({
          data: {
            slug: "pattern:order.#",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: patternEventDef.id } },
            taskSlug: "order-all-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            pattern: "order.#",
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // order.status.changed matches order.# (multi-level)
        const result = await service.call("order.status.changed", env, { orderId: "o2" });
        expect(result.runs).toHaveLength(1);
        expect(result.runs[0].taskIdentifier).toBe("order-all-handler");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "pattern + filter combination works",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, [
          "high-value-order-watcher",
          "all-order-watcher",
        ]);

        // Create event definition
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.created",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Pattern subscription with filter: order.* + amount > 1000
        const patternEventDef = await prisma.eventDefinition.create({
          data: {
            slug: "pattern:order.*",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: patternEventDef.id } },
            taskSlug: "high-value-order-watcher",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            pattern: "order.*",
            filter: { amount: [{ $gt: 1000 }] },
          },
        });

        // Pattern subscription without filter: order.*
        const patternEventDef2 = await prisma.eventDefinition.create({
          data: {
            slug: "pattern:order.*:all",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: patternEventDef2.id } },
            taskSlug: "all-order-watcher",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
            pattern: "order.*",
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Low value order — only all-order-watcher (pattern matches but filter doesn't)
        const result1 = await service.call("order.created", env, { orderId: "o1", amount: 50 });
        expect(result1.runs).toHaveLength(1);
        expect(result1.runs[0].taskIdentifier).toBe("all-order-watcher");

        // High value order — both watchers
        const result2 = await service.call("order.created", env, { orderId: "o2", amount: 5000 });
        expect(result2.runs).toHaveLength(2);
        const taskIds = result2.runs.map((r) => r.taskIdentifier).sort();
        expect(taskIds).toEqual(["all-order-watcher", "high-value-order-watcher"]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "idempotency key prevents duplicate fan-out",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "handler-task");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "payment.received",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "handler-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // First publish
        const result1 = await service.call("payment.received", env, { amount: 100 }, {
          idempotencyKey: "pay-123",
        });

        expect(result1.runs).toHaveLength(1);
        const firstRunId = result1.runs[0].runId;

        // Second publish with same idempotency key — should return cached run
        const result2 = await service.call("payment.received", env, { amount: 100 }, {
          idempotencyKey: "pay-123",
        });

        expect(result2.runs).toHaveLength(1);
        expect(result2.runs[0].runId).toBe(firstRunId);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "ordering key sets concurrencyKey on triggered runs",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "order-processor");

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.updated",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "order-processor",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        // Publish with ordering key
        const result = await service.call("order.updated", env, { orderId: "ord-1" }, {
          orderingKey: "ord-1",
        });

        expect(result.runs).toHaveLength(1);

        // Verify the run has the concurrency key set
        const dbRun = await prisma.taskRun.findFirst({
          where: { friendlyId: result.runs[0].runId },
        });
        expect(dbRun).toBeDefined();
        expect(dbRun!.concurrencyKey).toBe("evt:order.updated:ord-1");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "consumer group: only one task in group receives each event",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIds = ["processor-a", "processor-b", "processor-c", "standalone-task"];
        const { worker } = await setupBackgroundWorker(engine, env, taskIds);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "order.placed",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // 3 tasks in the same consumer group
        for (const taskSlug of ["processor-a", "processor-b", "processor-c"]) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
              consumerGroup: "order-processors",
            },
          });
        }

        // 1 standalone task (no consumer group)
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "standalone-task",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("order.placed", env, { orderId: "o1" });

        // Should have 2 runs: 1 from consumer group (picked one) + 1 standalone
        expect(result.runs).toHaveLength(2);

        const triggeredTasks = result.runs.map((r) => r.taskIdentifier);
        // standalone-task always gets it
        expect(triggeredTasks).toContain("standalone-task");

        // Exactly one of the consumer group members gets it
        const groupMembers = triggeredTasks.filter((t) =>
          ["processor-a", "processor-b", "processor-c"].includes(t)
        );
        expect(groupMembers).toHaveLength(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "consumer group: tasks without group and with group both work",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIds = ["group-a-1", "group-a-2", "group-b-1", "group-b-2", "no-group"];
        const { worker } = await setupBackgroundWorker(engine, env, taskIds);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "item.sold",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Group A: 2 members
        for (const taskSlug of ["group-a-1", "group-a-2"]) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
              consumerGroup: "group-a",
            },
          });
        }

        // Group B: 2 members
        for (const taskSlug of ["group-b-1", "group-b-2"]) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
              consumerGroup: "group-b",
            },
          });
        }

        // No group
        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "no-group",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("item.sold", env, { itemId: "i1" });

        // 3 runs: 1 from group-a, 1 from group-b, 1 ungrouped
        expect(result.runs).toHaveLength(3);

        const triggeredTasks = result.runs.map((r) => r.taskIdentifier);
        expect(triggeredTasks).toContain("no-group");

        // Exactly one from each group
        const groupA = triggeredTasks.filter((t) => t.startsWith("group-a-"));
        const groupB = triggeredTasks.filter((t) => t.startsWith("group-b-"));
        expect(groupA).toHaveLength(1);
        expect(groupB).toHaveLength(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publishAndWait: parentRunId creates waitpoints for each subscriber",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIds = ["parent-task", "handler-a", "handler-b"];
        const { worker } = await setupBackgroundWorker(engine, env, taskIds);

        // Create event definition
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "data.ready",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Subscribe both handlers
        for (const taskSlug of ["handler-a", "handler-b"]) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
            },
          });
        }

        // Trigger a parent run first so we have a valid parentRunId
        const triggerSvc = createTriggerTaskService(prisma, engine);
        const parentResult = await triggerSvc.call({
          taskId: "parent-task",
          environment: env,
          body: { payload: { setup: true } },
          options: {},
        });
        expect(parentResult).toBeDefined();
        const parentRunId = parentResult!.run.friendlyId;

        // Now publish with parentRunId
        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("data.ready", env, { value: 42 }, {
          parentRunId,
        });

        expect(result.runs).toHaveLength(2);
        expect(result.runs.every((r) => r.internalRunId !== undefined)).toBe(true);

        // Verify the triggered runs have resumeParentOnCompletion set
        for (const run of result.runs) {
          const dbRun = await prisma.taskRun.findFirst({
            where: { friendlyId: run.runId },
          });
          expect(dbRun).toBeDefined();
          expect(dbRun!.resumeParentOnCompletion).toBe(true);
        }

        const triggeredTasks = result.runs.map((r) => r.taskIdentifier).sort();
        expect(triggeredTasks).toEqual(["handler-a", "handler-b"]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "publishAndWait: no subscribers returns empty runs with no waitpoints",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "parent-task");

        // Create event definition with no subscribers
        await prisma.eventDefinition.create({
          data: {
            slug: "empty.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        // Create a parent run
        const triggerSvc = createTriggerTaskService(prisma, engine);
        const parentResult = await triggerSvc.call({
          taskId: "parent-task",
          environment: env,
          body: { payload: {} },
          options: {},
        });
        const parentRunId = parentResult!.run.friendlyId;

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn);

        const result = await service.call("empty.event", env, { data: "test" }, {
          parentRunId,
        });

        expect(result.runs).toHaveLength(0);
        expect(result.eventId).toMatch(/^evt_/);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "event log writer receives correct fanOutCount and event metadata",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, ["task-a", "task-b"]);

        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "audit.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        for (const taskSlug of ["task-a", "task-b"]) {
          await prisma.eventSubscription.create({
            data: {
              eventDefinition: { connect: { id: eventDef.id } },
              taskSlug,
              project: { connect: { id: env.projectId } },
              environment: { connect: { id: env.id } },
              worker: { connect: { id: worker.id } },
              enabled: true,
            },
          });
        }

        const logEntries: any[] = [];
        const mockLogWriter = (entry: any) => logEntries.push(entry);

        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn, mockLogWriter);

        const result = await service.call("audit.event", env, { action: "test" }, {
          idempotencyKey: "audit-key-1",
          metadata: { source: "test" },
        });

        expect(result.runs).toHaveLength(2);

        // Verify event log writer was called
        expect(logEntries).toHaveLength(1);
        const entry = logEntries[0];
        expect(entry.eventType).toBe("audit.event");
        expect(entry.fanOutCount).toBe(2);
        expect(entry.idempotencyKey).toBe("audit-key-1");
        expect(entry.metadata).toEqual({ source: "test" });
        expect(entry.environmentId).toBe(env.id);
        expect(entry.projectId).toBe(env.projectId);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "rate limiter blocks publishes that exceed the configured limit",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "limited-handler");

        // Create event definition with rate limit: 2 publishes per 10s
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "rate.limited.event",
            version: "1.0",
            projectId: env.projectId,
            rateLimit: { limit: 2, window: "10s" },
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "limited-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const rateLimitChecker = new InMemoryEventRateLimitChecker();
        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn, undefined, rateLimitChecker);

        // First two publishes should succeed
        const result1 = await service.call("rate.limited.event", env, { n: 1 });
        expect(result1.runs).toHaveLength(1);

        const result2 = await service.call("rate.limited.event", env, { n: 2 });
        expect(result2.runs).toHaveLength(1);

        // Third publish should be rate limited
        await expect(
          service.call("rate.limited.event", env, { n: 3 })
        ).rejects.toThrow(EventPublishRateLimitError);

        // Verify error properties
        try {
          await service.call("rate.limited.event", env, { n: 4 });
          expect.unreachable("Should have thrown");
        } catch (error) {
          expect(error).toBeInstanceOf(EventPublishRateLimitError);
          const rle = error as EventPublishRateLimitError;
          expect(rle.eventSlug).toBe("rate.limited.event");
          expect(rle.limit).toBe(2);
          expect(rle.remaining).toBe(0);
          expect(rle.retryAfterMs).toBeGreaterThan(0);
        }
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "rate limiter does not block when no rateLimit is configured",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { worker } = await setupBackgroundWorker(engine, env, "unlimited-handler");

        // Create event definition WITHOUT rate limit
        const eventDef = await prisma.eventDefinition.create({
          data: {
            slug: "unlimited.event",
            version: "1.0",
            projectId: env.projectId,
          },
        });

        await prisma.eventSubscription.create({
          data: {
            eventDefinition: { connect: { id: eventDef.id } },
            taskSlug: "unlimited-handler",
            project: { connect: { id: env.projectId } },
            environment: { connect: { id: env.id } },
            worker: { connect: { id: worker.id } },
            enabled: true,
          },
        });

        const rateLimitChecker = new InMemoryEventRateLimitChecker();
        const triggerFn = buildTriggerFn(prisma, engine);
        const service = new PublishEventService(prisma, triggerFn, undefined, rateLimitChecker);

        // Should be able to publish many times without limit
        for (let i = 0; i < 5; i++) {
          const result = await service.call("unlimited.event", env, { n: i });
          expect(result.runs).toHaveLength(1);
        }
      } finally {
        await engine.quit();
      }
    }
  );
});
