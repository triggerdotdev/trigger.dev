import { describe, expect, onTestFinished, vi } from "vitest";
import type * as ResolveRunMintTargetModule from "~/v3/runOpsMigration/resolveRunMintTarget.server";

// db.server + splitMode are mocked so the idempotency dedup client resolves to
// the container prisma passed into the concern (split stays off).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

vi.mock("~/v3/runOpsMigration/resolveRunMintTarget.server", async (importOriginal) => {
  const actual = await importOriginal<typeof ResolveRunMintTargetModule>();
  return { ...actual, resolveRunMintTarget: vi.fn(actual.resolveRunMintTarget) };
});

import { RunEngine } from "@internal/run-engine";
import {
  MEMORYDB_SHARD_KEY,
  organizationContext,
  PostgresRunStore,
  RoutingRunStore,
  type RunStore,
} from "@internal/run-store";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import {
  RunId,
  classifyKind,
  generateInternalId,
  generateRunOpsId,
  generateRunOpsIdV2,
} from "@trigger.dev/core/v3/isomorphic";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { resolveRunMintTarget } from "~/v3/runOpsMigration/resolveRunMintTarget.server";
import { createRunResidencyGate } from "~/v3/utils/runResidencyGate.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("RunEngineTriggerTaskService — child run residency inheritance", () => {
  // Helper: stand up an engine + service wired for a single (real) Postgres/Redis
  // pair. Returns the service plus the authenticated environment and a registered
  // task identifier.
  async function setupResidencyService(
    prisma: any,
    redisOptions: any,
    idempotencyKeyConcernOverride?: IdempotencyKeyConcern
  ) {
    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions },
      runLock: { redis: redisOptions },
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
    onTestFinished(() => engine.quit());

    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const taskIdentifier = "residency-task";
    await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

    const queuesManager = new DefaultQueueManager(prisma, engine);
    const idempotencyKeyConcern =
      idempotencyKeyConcernOverride ??
      new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern());

    const triggerTaskService = new RunEngineTriggerTaskService({
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

    return { engine, authenticatedEnvironment, taskIdentifier, triggerTaskService };
  }

  containerTest(
    "root run mints by the env flag (cuid when split is off)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "root" } },
      });

      expect(result?.run.friendlyId).toBeDefined();
      // Split disabled in CI ⇒ flag resolves "cuid".
      expect(classifyKind(result!.run.friendlyId)).toBe("cuid");
    }
  );

  containerTest(
    "child of a LEGACY (cuid) parent is minted cuid (born LEGACY)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Root parent — cuid in CI (split off).
      const parent = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "parent" } },
      });
      expect(classifyKind(parent!.run.friendlyId)).toBe("cuid");

      const child = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "child" }, options: { parentRunId: parent!.run.friendlyId } },
      });

      expect(classifyKind(child!.run.friendlyId)).toBe("cuid");
    }
  );

  containerTest(
    "child of a NEW (run-ops id) parent is minted run-ops id (born NEW)",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Construct a NEW-resident parent directly by minting a run-ops id friendlyId
      // and creating its run row, so the child inherits NEW by id-shape alone
      // (no marker needed). We trigger the parent with an explicit run-ops id via
      // the runFriendlyId option so the row physically exists for the parent
      // lookup the child path performs.
      // v1 id (version "1" at index 25) → classifies NEW
      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
      expect(classifyKind(parentFriendlyId)).toBe("runOpsId");

      const parent = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "parent" } },
        options: { runFriendlyId: parentFriendlyId },
      });
      expect(parent!.run.friendlyId).toBe(parentFriendlyId);

      const child = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "child" }, options: { parentRunId: parentFriendlyId } },
      });

      expect(classifyKind(child!.run.friendlyId)).toBe("runOpsId");
    }
  );

  containerTest(
    "caller-supplied runFriendlyId wins verbatim and skips residency inheritance",
    async ({ prisma, redisOptions }) => {
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions);

      // Explicit cuid id for the run, and a run-ops id/NEW parent id.
      const explicitFriendlyId = RunId.toFriendlyId(generateInternalId());
      const parentFriendlyId = RunId.toFriendlyId(generateRunOpsId());
      expect(classifyKind(explicitFriendlyId)).toBe("cuid");
      expect(classifyKind(parentFriendlyId)).toBe("runOpsId");

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "explicit" }, options: { parentRunId: parentFriendlyId } },
        options: { runFriendlyId: explicitFriendlyId },
      });

      // Caller-supplied id wins verbatim — NOT re-minted to run-ops id despite the NEW parent.
      expect(result!.run.friendlyId).toBe(explicitFriendlyId);
    }
  );

  // Catches: a root minted after the idempotency check, or from flags other than the environment's.
  containerTest(
    "a root's id is minted before the idempotency check, from the environment's flags",
    async ({ prisma, redisOptions }) => {
      let captured: string | undefined;
      const idempotencyKeyConcern = {
        handleTriggerRequest: async (request: { friendlyId: string }) => {
          captured = request.friendlyId;
          throw new Error("stop at the idempotency check");
        },
      } as unknown as IdempotencyKeyConcern;
      const { authenticatedEnvironment, taskIdentifier, triggerTaskService } =
        await setupResidencyService(prisma, redisOptions, idempotencyKeyConcern);
      const featureFlags = { marker: "environment flags" };
      const environment = {
        ...authenticatedEnvironment,
        organization: { ...authenticatedEnvironment.organization, featureFlags },
      };
      const mint = vi.mocked(resolveRunMintTarget);
      mint.mockClear();

      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: { payload: { test: "root" } },
        })
      ).rejects.toThrow("stop at the idempotency check");

      expect(captured).toMatch(/^run_/);
      expect(mint).toHaveBeenCalledTimes(1);
      expect(mint.mock.calls[0]![0].environment.orgFeatureFlags).toBe(featureFlags);
    }
  );
});

describe("engine jobs decide the MemoryDB gate in their record's environment", () => {
  const STAMP_AT = "2026-01-01T00:00:00.000Z";
  const organizations: Array<[string, unknown, boolean]> = [
    ["plain", null, false],
    ["never-on", { activeRunStoreEnabled: true }, false],
    ["on-record-off", { runResidencyEnabled: true, activeRunStoreEnabled: false }, false],
    ["on", { runResidencyEnabled: true, activeRunStoreEnabled: true }, true],
    [
      "was-on",
      {
        runResidencyEnabled: false,
        runResidencyEnabledPrev: true,
        runResidencyEnabledFlippedAt: STAMP_AT,
        activeRunStoreEnabled: true,
      },
      true,
    ],
    [
      "removed",
      {
        runResidencyEnabledPrev: true,
        runResidencyEnabledFlippedAt: STAMP_AT,
        activeRunStoreEnabled: true,
      },
      true,
    ],
  ];

  // An engine whose router holds a stand-in under m and the real gate. Each organisation gets its
  // own environment, and the counting resolver answers that environment's flags, so every call can
  // be attributed to one organisation. The stand-in returns one edge per waitpoint, of a generation
  // 3 run of its own; that run's continueRunIfUnblocked job is recorded, not enqueued.
  async function setupGatedEngine(prisma: any, redisOptions: any) {
    const flagsByEnvironment = new Map<string, unknown>();
    const lookups: string[] = [];
    const standInCalls: Array<{ waitpointId: unknown; environmentId: string | undefined }> = [];
    const memoryDbRunIds = new Map<string, string>();
    const runIdFor = (waitpointId: string) => {
      if (!memoryDbRunIds.has(waitpointId)) {
        memoryDbRunIds.set(waitpointId, generateRunOpsIdV2(MEMORYDB_SHARD_KEY));
      }
      return memoryDbRunIds.get(waitpointId)!;
    };
    const standIn = {
      findManyTaskRunWaitpoints: async (args: { where: { waitpointId: string } }) => {
        const waitpointId = args.where.waitpointId;
        standInCalls.push({ waitpointId, environmentId: organizationContext.get()?.environmentId });
        return [
          { taskRunId: runIdFor(waitpointId), spanIdToComplete: null, createdAt: new Date() },
        ];
      },
    } as unknown as RunStore;
    const router = new RoutingRunStore({
      new: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      legacy: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      shards: [{ key: MEMORYDB_SHARD_KEY, store: standIn }],
      memoryDbGate: createRunResidencyGate({
        readGlobalFlags: () => ({}),
        resolveAuthenticatedEnv: async (environmentId) => {
          lookups.push(environmentId);
          return { organization: { featureFlags: flagsByEnvironment.get(environmentId) ?? null } };
        },
      }),
    });

    // The waitpoint ids whose completion fan-out has returned.
    const fannedOut = new Set<string>();
    const find = router.findManyTaskRunWaitpoints.bind(router);
    vi.spyOn(router, "findManyTaskRunWaitpoints").mockImplementation((async (
      args: any,
      client: any
    ) => {
      const rows = await find(args, client);
      const waitpointId = args.where?.waitpointId;
      if (typeof waitpointId === "string") fannedOut.add(waitpointId);
      return rows;
    }) as any);

    const engine = new RunEngine({
      prisma,
      store: router,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: { redis: redisOptions },
      runLock: { redis: redisOptions },
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
    onTestFinished(() => engine.quit());

    const resumed: string[] = [];
    const worker = engine["worker"];
    const enqueue = worker.enqueue.bind(worker);
    vi.spyOn(worker, "enqueue").mockImplementation(async (options) => {
      if (
        options.job === "continueRunIfUnblocked" &&
        [...memoryDbRunIds.values()].includes(options.payload.runId)
      ) {
        resumed.push(options.payload.runId);
        return;
      }
      return enqueue(options);
    });

    const authenticated = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const environmentFor = async (name: string, featureFlags: unknown) => {
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          type: "PRODUCTION",
          slug: `prod-${name}`,
          projectId: authenticated.project.id,
          organizationId: authenticated.organization.id,
          apiKey: `tr_prod_${name}`,
          pkApiKey: `pk_prod_${name}`,
          shortcode: `short_${name}`,
          maximumConcurrencyLimit: 10,
        },
      });
      flagsByEnvironment.set(environment.id, featureFlags);
      return environment;
    };

    // Everything recorded for one organisation's environment and waitpoint.
    const recordedFor = (environmentId: string, waitpointId: string) => ({
      lookups: lookups.filter((id) => id === environmentId),
      standInCalls: standInCalls.filter((c) => c.waitpointId === waitpointId),
      resumed: resumed.filter((id) => id === memoryDbRunIds.get(waitpointId)),
    });

    return {
      engine,
      projectId: authenticated.project.id,
      organizationId: authenticated.organization.id,
      environmentFor,
      fannedOut,
      runIdFor,
      recordedFor,
    };
  }

  // Catches: a timeout job whose fan-out is decided without its token's environment, so an open
  // organisation's MemoryDB run is never resumed, or a closed one's store under m is asked.
  containerTest(
    "a standalone token's timeout job gets each organisation's decision, with one look-up",
    async ({ prisma, redisOptions }) => {
      const gated = await setupGatedEngine(prisma, redisOptions);
      const expected = (
        name: string,
        environmentId: string,
        waitpointId: string,
        opens: boolean
      ) => ({
        name,
        lookups: [environmentId],
        standInCalls: opens ? [{ waitpointId, environmentId }] : [],
        resumed: opens ? [gated.runIdFor(waitpointId)] : [],
      });
      const done: Array<{
        name: string;
        environmentId: string;
        waitpointId: string;
        opens: boolean;
      }> = [];

      for (const [name, featureFlags, opens] of organizations) {
        const environment = await gated.environmentFor(name, featureFlags);
        const { waitpoint } = await gated.engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: gated.projectId,
          organizationId: gated.organizationId,
          timeout: new Date(Date.now() + 600),
        });

        // Wait for the job's fan-out to return, and for an open organisation's resume enqueue.
        await vi.waitFor(
          () => {
            expect(gated.fannedOut.has(waitpoint.id)).toBe(true);
            if (opens) {
              expect(gated.recordedFor(environment.id, waitpoint.id).resumed).toHaveLength(1);
            }
          },
          { timeout: 10_000, interval: 50 }
        );
        const row = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect({ name, status: row?.status }).toEqual({ name, status: "COMPLETED" });
        expect({ name, ...gated.recordedFor(environment.id, waitpoint.id) }).toEqual(
          expected(name, environment.id, waitpoint.id, opens)
        );
        done.push({ name, environmentId: environment.id, waitpointId: waitpoint.id, opens });
      }

      // No organisation's job left a late call behind.
      for (const { name, environmentId, waitpointId, opens } of done) {
        expect({ name, ...gated.recordedFor(environmentId, waitpointId) }).toEqual(
          expected(name, environmentId, waitpointId, opens)
        );
      }
    }
  );

  // Catches: the wrap replacing a request's flags in hand with a look-up of the waitpoint's
  // environment.
  containerTest(
    "a completion inside a request decides from the request's flags, with no look-up",
    async ({ prisma, redisOptions }) => {
      const gated = await setupGatedEngine(prisma, redisOptions);

      for (const [name, featureFlags, opens] of organizations.filter(([n]) =>
        ["never-on", "on"].includes(n)
      )) {
        const environment = await gated.environmentFor(name, featureFlags);
        const { waitpoint } = await gated.engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: gated.projectId,
          organizationId: gated.organizationId,
        });

        await organizationContext.run(
          { organizationId: gated.organizationId, environmentId: environment.id, featureFlags },
          () => gated.engine.completeWaitpoint({ id: waitpoint.id })
        );

        expect({ name, ...gated.recordedFor(environment.id, waitpoint.id) }).toEqual({
          name,
          lookups: [],
          standInCalls: opens ? [{ waitpointId: waitpoint.id, environmentId: environment.id }] : [],
          resumed: opens ? [gated.runIdFor(waitpoint.id)] : [],
        });
      }
    }
  );
});
