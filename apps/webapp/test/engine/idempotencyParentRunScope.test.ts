import { describe, expect, vi } from "vitest";

// Mock the db prisma singleton so the real testcontainer prisma is used
// instead of the webapp's env-bound client (mirrors triggerTask.test.ts).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import {
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  type AuthenticatedEnvironment,
} from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { IOPacket } from "@trigger.dev/core/v3";
import {
  Decimal,
  type PrismaClient,
  type RuntimeEnvironmentType,
  type TaskRun,
} from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import type {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  TagValidationParams,
  TraceEventConcern,
  TracedEventSpan,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { setTimeout } from "node:timers/promises";

vi.setConfig({ testTimeout: 60_000 });

class MockPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return {
      data: JSON.stringify(request.body.payload),
      dataType: "application/json",
    };
  }
}

// Permissive validator: the main (non-cached) trigger path is not the
// subject here — we want the cached idempotency branch's own scoping
// guard to be the only thing standing between a caller and an
// arbitrary parent run.
class MockTriggerTaskValidator implements TriggerTaskValidator {
  validateTags(_params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(_params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(_params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(_params: ParentRunValidationParams): ValidationResult {
    return { ok: true };
  }
}

const MOCK_TRACE_ID = "0123456789abcdef0123456789abcdef";
const MOCK_SPAN_ID = "fedcba9876543210";
const MOCK_TRACEPARENT = `00-${MOCK_TRACE_ID}-${MOCK_SPAN_ID}-01`;

class MockTraceEventConcern implements TraceEventConcern {
  private span(): TracedEventSpan {
    return {
      traceId: MOCK_TRACE_ID,
      spanId: MOCK_SPAN_ID,
      traceContext: { traceparent: MOCK_TRACEPARENT },
      traceparent: undefined,
      setAttribute: () => {},
      failWithError: () => {},
      stop: () => {},
    };
  }
  async traceRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return callback(this.span(), "test");
  }
  async traceIdempotentRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return callback(this.span(), "test");
  }
  async traceDebouncedRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: { existingRun: TaskRun; debounceKey: string; incomplete: boolean; isError: boolean },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return callback(this.span(), "test");
  }
}

// setupAuthenticatedEnvironment hardcodes every unique field (slug,
// apiKey, shortcode, ...), so it can only be called once per database.
// This builds a second, fully-distinct tenant for the cross-environment
// assertion.
async function createDistinctTenant(
  prisma: PrismaClient,
  type: RuntimeEnvironmentType,
  suffix: string
): Promise<AuthenticatedEnvironment> {
  const org = await prisma.organization.create({
    data: { title: `Test Org ${suffix}`, slug: `test-organization-${suffix}` },
  });
  const workerGroup = await prisma.workerInstanceGroup.create({
    data: {
      name: `default-${suffix}`,
      masterQueue: `default-${suffix}`,
      type: "MANAGED",
      token: { create: { tokenHash: `token_hash_${suffix}` } },
    },
  });
  const project = await prisma.project.create({
    data: {
      name: `Test Project ${suffix}`,
      slug: `test-project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: org.id,
      defaultWorkerGroupId: workerGroup.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: `slug-${suffix}`,
      projectId: project.id,
      organizationId: org.id,
      apiKey: `api_key_${suffix}`,
      pkApiKey: `pk_api_key_${suffix}`,
      shortcode: `short_code_${suffix}`,
      maximumConcurrencyLimit: 10,
      concurrencyLimitBurstFactor: new Decimal(2.0),
    },
  });
  return prisma.runtimeEnvironment.findUniqueOrThrow({
    where: { id: environment.id },
    include: { project: true, organization: true, orgMember: true },
  });
}

describe("IdempotencyKeyConcern cached-branch parent-run scoping", () => {
  containerTest(
    "rejects a parentRunId from another environment, permits one from the caller's environment",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const parentTask = "parent-task";
      const childTask = "child-task";

      // Two independent tenants.
      const callerEnv = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const victimEnv = await createDistinctTenant(prisma, "PRODUCTION", "victim");

      await setupBackgroundWorker(engine, callerEnv, [parentTask, childTask]);
      await setupBackgroundWorker(engine, victimEnv, [parentTask, childTask]);

      // Helper: trigger a parent run and start its attempt so it is a
      // valid waitpoint target for resumeParentOnCompletion.
      const triggerAndStart = async (
        env: typeof callerEnv,
        friendlyId: string,
        idSuffix: string
      ) => {
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId,
            environment: env,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: `t${idSuffix}`,
            spanId: `s${idSuffix}`,
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
          },
          prisma
        );
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: `consumer${idSuffix}`,
          workerQueue: "main",
        });
        await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued[0].snapshot.id });
        return run;
      };

      // Victim parent lives in the OTHER environment.
      const victimParent = await triggerAndStart(victimEnv, "run_victimp", "11111");
      // A legitimate parent in the caller's own environment.
      const callerParent = await triggerAndStart(callerEnv, "run_callerp", "22222");

      const queuesManager = new DefaultQueueManager(prisma, engine);
      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );

      const service = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      // Seed two cached idempotent child runs in the caller's env. The
      // first call for each key takes the non-cached path and creates the
      // run; the second call hits the cached branch under test.
      const crossEnvKey = "cross-env-key";
      const sameEnvKey = "same-env-key";

      const seedCross = await service.call({
        taskId: childTask,
        environment: callerEnv,
        body: { payload: { n: 1 }, options: { idempotencyKey: crossEnvKey } },
      });
      expect(seedCross?.isCached).toBe(false);

      const seedSame = await service.call({
        taskId: childTask,
        environment: callerEnv,
        body: { payload: { n: 2 }, options: { idempotencyKey: sameEnvKey } },
      });
      expect(seedSame?.isCached).toBe(false);

      // ATTACK: cached call in the caller's env naming the victim's parent
      // run (which belongs to victimEnv). Must be refused.
      await expect(
        service.call({
          taskId: childTask,
          environment: callerEnv,
          body: {
            payload: { n: 1 },
            options: {
              idempotencyKey: crossEnvKey,
              parentRunId: victimParent.friendlyId,
              resumeParentOnCompletion: true,
            },
          },
        })
      ).rejects.toThrow(/Parent run not found in the calling environment/);

      // CONTROL: same cached path, but the parent is in the caller's own
      // env — the guard must let this through (isCached hit).
      const sameEnvResult = await service.call({
        taskId: childTask,
        environment: callerEnv,
        body: {
          payload: { n: 2 },
          options: {
            idempotencyKey: sameEnvKey,
            parentRunId: callerParent.friendlyId,
            resumeParentOnCompletion: true,
          },
        },
      });
      expect(sameEnvResult?.isCached).toBe(true);
      expect(sameEnvResult?.run.friendlyId).toBe(seedSame?.run.friendlyId);

      // And the cross-tenant victim run must NOT have been blocked by the
      // attacker's waitpoint — its execution snapshot stays in its own env.
      const victimAfter = await prisma.taskRun.findFirst({
        where: { id: victimParent.id },
        select: { runtimeEnvironmentId: true },
      });
      expect(victimAfter?.runtimeEnvironmentId).toBe(victimEnv.id);

      await engine.quit();
    }
  );
});
