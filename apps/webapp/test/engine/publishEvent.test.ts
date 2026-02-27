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
  type TriggerFn,
} from "../../app/v3/services/events/publishEvent.server";
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
});
