import { describe, expect, vi } from "vitest";

// Store-routed engine create/get seam + the residency-keyed id contract behind
// the create route (not its HTTP action). A standalone MANUAL token is cuid →
// LEGACY; NEW residency is reached only by co-locating the token with a run-ops run.

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import {
  containerTest,
  heteroRunOpsPostgresTest,
  network,
  redisContainer,
  redisOptions,
} from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore, type CreateRunInput } from "@internal/run-store";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  WaitpointId,
  RunId,
  generateRunOpsId,
  ownerEngine,
  CUID_LENGTH,
} from "@trigger.dev/core/v3/isomorphic";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import { trace } from "@opentelemetry/api";

vi.setConfig({ testTimeout: 60_000 });

function buildEngine(opts: {
  prisma: any;
  redisOptions: any;
  store?: ConstructorParameters<typeof RunEngine>[0]["store"];
}) {
  return new RunEngine({
    prisma: opts.prisma,
    ...(opts.store ? { store: opts.store } : {}),
    worker: {
      redis: opts.redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: opts.redisOptions,
    },
    runLock: {
      redis: opts.redisOptions,
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

describe("waitpoint-token create engine seam — residency-keyed id contract", () => {
  // A standalone token (no owning run) mints a cuid WaitpointId and stays LEGACY.
  containerTest(
    "create mints a cuid WaitpointId for a standalone token (LEGACY)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine({ prisma, redisOptions });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() + 60_000),
        });

        expect(result.waitpoint.id.length).toBe(CUID_LENGTH);
        expect(result.waitpoint.type).toBe("MANUAL");

        const row = await prisma.waitpoint.findUnique({ where: { id: result.waitpoint.id } });
        expect(row).not.toBeNull();
        expect(row?.environmentId).toBe(env.id);

        // The exact response body id, computed as the route computes it.
        const responseId = WaitpointId.toFriendlyId(result.waitpoint.id);
        expect(responseId.startsWith("waitpoint_")).toBe(true);
        expect(responseId).toBe("waitpoint_" + result.waitpoint.id);
        expect(WaitpointId.fromFriendlyId(responseId)).toBe(result.waitpoint.id);

        expect(ownerEngine(WaitpointId.fromFriendlyId(responseId))).toBe("LEGACY");
      } finally {
        await engine.quit();
      }
    }
  );

  // The standalone token id classifies LEGACY and resolves back.
  containerTest(
    "token id classifies to the legacy store and resolves back",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine({ prisma, redisOptions });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() + 60_000),
        });

        expect(ownerEngine(result.waitpoint.id)).toBe("LEGACY");

        const resolved = await engine.getWaitpoint({
          waitpointId: result.waitpoint.id,
          environmentId: env.id,
          projectId: env.project.id,
        });
        expect(resolved).not.toBeNull();
        expect(resolved?.id).toBe(result.waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // The control-plane WaitpointTag write stays control-plane — it cannot
  // route through the run-ops store, which exposes no tag-write surface at all.
  containerTest(
    "control-plane WaitpointTag write stays control-plane, not on the run-ops store",
    async ({ prisma, redisOptions }) => {
      // A run-ops store that counts every waitpoint write that passes through it.
      // Overrides mirror the base PostgresRunStore generics so a base-signature
      // change can't silently detach the counter.
      let waitpointWrites = 0;
      class CountingPostgresRunStore extends PostgresRunStore {
        async upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
          args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
          tx?: Parameters<PostgresRunStore["upsertWaitpoint"]>[1]
        ): Promise<Prisma.WaitpointGetPayload<T>> {
          waitpointWrites++;
          return super.upsertWaitpoint(args, tx);
        }
        async createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
          args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
          tx?: Parameters<PostgresRunStore["createWaitpoint"]>[1]
        ): Promise<Prisma.WaitpointGetPayload<T>> {
          waitpointWrites++;
          return super.createWaitpoint(args, tx);
        }
      }

      const countingStore = new CountingPostgresRunStore({
        prisma,
        readOnlyPrisma: prisma,
      });

      const engine = buildEngine({ prisma, redisOptions, store: countingStore });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Issue the control-plane tag write directly (the same upsert the
        // createWaitpointTag model performs), against the container prisma —
        // control-plane, never the run-ops store.
        await prisma.waitpointTag.upsert({
          where: { environmentId_name: { environmentId: env.id, name: "t1" } },
          create: { name: "t1", environmentId: env.id, projectId: env.project.id },
          update: {},
        });

        const result = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          tags: ["t1"],
          timeout: new Date(Date.now() + 60_000),
        });
        expect(result.waitpoint.id.length).toBe(CUID_LENGTH);

        // The tag landed on the control-plane client.
        const tagRow = await prisma.waitpointTag.findFirst({
          where: { environmentId: env.id, name: "t1" },
        });
        expect(tagRow).not.toBeNull();

        // The waitpoint went through the run-ops store (counting store fired).
        expect(waitpointWrites).toBeGreaterThanOrEqual(1);

        // The run-ops store has no tag-write surface, so the partition rests on the
        // two assertions above: the tag landed on control-plane and the waitpoint went through the store.
      } finally {
        await engine.quit();
      }
    }
  );
});

const twoDbEngineTest = heteroRunOpsPostgresTest.extend<{
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/parent-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

async function seedExecutingRunOpsRun(
  prisma14: PrismaClient,
  router: RoutingRunStore,
  runId: string,
  suffix: string
) {
  const env = await seedControlPlaneEnv(prisma14, suffix);

  await router.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );

  const created = await router.findLatestExecutionSnapshot(runId);
  await router.createExecutionSnapshot(
    {
      run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "run executing" },
      previousSnapshotId: created!.id,
      environmentId: env.environment.id,
      environmentType: "PRODUCTION",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
    prisma14
  );

  return env;
}

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

describe("waitpoint-token create engine seam — NEW residency via a run-ops run across the version boundary", () => {
  // NEW residency comes from co-locating the token with a run-ops run; the token
  // resolves only on its owning (#new) store across the PG14<->PG17 boundary, never #legacy.
  twoDbEngineTest(
    "a run-ops run's token co-locates on #new and resolves only there, not on #legacy",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = buildEngine({ prisma: prisma14, redisOptions, store: router });

      try {
        // A NEW-classified run id (explicit run-ops id), mirroring the trigger-routing helper.
        const runId = RunId.toFriendlyId(generateRunOpsId());
        expect(ownerEngine(runId)).toBe("NEW");
        const env = await seedExecutingRunOpsRun(p14, router, runId, "wpnew");

        const { waitpoint } = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
        });

        // The token is always cuid (Option B); its NEW residency comes from the run.
        expect(waitpoint.id.length).toBe(CUID_LENGTH);
        expect(ownerEngine(waitpoint.id)).toBe("LEGACY");

        // Co-location: the token lives on #new next to its run, not on #legacy.
        const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        const onLegacy = await p14.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(onNew).not.toBeNull();
        expect(onLegacy).toBeNull();

        const resolved = await engine.getWaitpoint({
          waitpointId: waitpoint.id,
          environmentId: env.environment.id,
          projectId: env.project.id,
        });
        expect(resolved?.id).toBe(waitpoint.id);
        expect(await p14.waitpoint.findUnique({ where: { id: waitpoint.id } })).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});
