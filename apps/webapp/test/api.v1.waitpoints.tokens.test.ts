import { describe, expect, it, vi } from "vitest";

// Store-routed engine create/get seam + the residency-keyed id contract behind
// the create route (not its HTTP action). A standalone MANUAL token is cuid →
// LEGACY; NEW residency is reached only by co-locating the token with a run-ops run.

// The placement tests below drive the real token route and webhook waiter ports with the
// placement inputs (mint kind, shard) and the writers (engine, tag model, run store) replaced by
// spies. The engine-seam tests build their own RunEngine and import none of these modules.
const H = vi.hoisted(() => ({
  environment: undefined as any,
  mintKind: "cuid" as "cuid" | "runOpsId",
  shardKey: undefined as string | undefined,
  storeEnabled: false,
  createManualWaitpoint: undefined as any,
  readExistingStoreDateTimeWaitpointByKey: undefined as any,
  createWaitpointTag: undefined as any,
  findWaitpoint: undefined as any,
}));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    prisma: {},
    $replica: {},
    runOpsNewReplicaClient: {},
    runOpsLegacyReplica: {},
    runOpsSplitReadEnabled: false,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: H.environment,
      subject: { type: "private" },
      ability: { can: () => true, canSuper: () => true },
      jwt: undefined,
    }),
  },
}));

vi.mock("~/v3/engineVersion.server", () => ({
  resolveRunIdMintKind: async () => H.mintKind,
}));

vi.mock("~/v3/runOpsMigration/runOpsMintShard.server", () => ({
  resolveMintShard: async () => H.shardKey,
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentById: async () => H.environment,
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    createManualWaitpoint: (...args: unknown[]) => H.createManualWaitpoint(...args),
    readExistingStoreDateTimeWaitpointByKey: (...args: unknown[]) =>
      H.readExistingStoreDateTimeWaitpointByKey(...args),
    waitpointSystem: { isWaitpointStoreEnabled: async () => H.storeEnabled },
  },
}));

vi.mock("~/models/waitpointTag.server", () => ({
  MAX_TAGS_PER_WAITPOINT: 10,
  createWaitpointTag: (...args: unknown[]) => H.createWaitpointTag(...args),
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: { findWaitpoint: (...args: unknown[]) => H.findWaitpoint(...args) },
}));

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
import { action as createTokenAction } from "~/routes/api.v1.waitpoints.tokens";
import { webhookWaitpoints } from "~/v3/webhookWaitpoints.server";

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

        const resolved = await engine.runStore.findWaitpoint(
          { where: { id: result.waitpoint.id } },
          engine.prisma
        );
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

        const resolved = await engine.runStore.findWaitpoint(
          { where: { id: waitpoint.id } },
          engine.prisma
        );
        expect(resolved?.id).toBe(waitpoint.id);
        expect(await p14.waitpoint.findUnique({ where: { id: waitpoint.id } })).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});

const PLACEMENTS = [
  { mintKind: "cuid", shard: undefined, residency: "LEGACY", shardKey: undefined },
  { mintKind: "runOpsId", shard: "new", residency: "NEW", shardKey: "new" },
  { mintKind: "runOpsId", shard: "a", residency: "NEW", shardKey: "a" },
] as const;

function placementEnvironment() {
  return {
    id: "env_placement",
    type: "PRODUCTION",
    slug: "prod",
    apiKey: "tr_prod_placement",
    organizationId: "org_placement",
    projectId: "proj_placement",
    organization: {
      id: "org_placement",
      slug: "org-placement",
      title: "Placement",
      featureFlags: {},
    },
    project: { id: "proj_placement", name: "Placement", externalRef: "proj_placement" },
  };
}

function resetPlacement(placement: (typeof PLACEMENTS)[number]) {
  H.environment = placementEnvironment();
  H.mintKind = placement.mintKind;
  H.shardKey = placement.shard;
  H.storeEnabled = false;
  H.createManualWaitpoint = vi.fn(async () => ({
    waitpoint: { id: "c".repeat(25) },
    isCached: false,
  }));
  H.readExistingStoreDateTimeWaitpointByKey = vi.fn(async () => undefined);
  H.createWaitpointTag = vi.fn(async ({ tag }: { tag: string }) => ({
    id: `tag_${tag}`,
    name: tag,
  }));
  H.findWaitpoint = vi.fn(async () => null);
}

describe("standalone token, tag and webhook waiter placement", () => {
  // Catches: a token or its tag placed on a store other than the mint kind and shard placement give.
  it("the token create route passes the placement's residency and shard key to the token and its tag", async () => {
    for (const placement of PLACEMENTS) {
      resetPlacement(placement);
      const body = JSON.stringify({ tags: ["t1"] });
      const response = await createTokenAction({
        request: new Request("http://localhost/api/v1/waitpoints/tokens", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${H.environment.apiKey}`,
            "content-type": "application/json",
            "content-length": String(body.length),
          },
          body,
        }),
        params: {},
        context: {},
      } as any);

      expect(response.status).toBe(200);
      const token = H.createManualWaitpoint.mock.calls[0][0];
      expect({ residency: token.standaloneResidency, shardKey: token.standaloneShardKey }).toEqual({
        residency: placement.residency,
        shardKey: placement.shardKey,
      });
      const tag = H.createWaitpointTag.mock.calls[0][0];
      expect({ residency: tag.residency, shardKey: tag.shardKey }).toEqual({
        residency: placement.residency,
        shardKey: placement.shardKey,
      });
    }
  });

  // Catches: a webhook waiter placed, or looked up, somewhere other than the token route would put it.
  it("webhook waiters create and find with the placement's residency and shard key, co-locating except on a gen-2 shard", async () => {
    for (const placement of PLACEMENTS) {
      resetPlacement(placement);
      await webhookWaitpoints.create({
        environmentId: H.environment.id,
        projectId: H.environment.projectId,
        idempotencyKey: "key_1",
        idempotencyKeyExpiresAt: undefined,
        timeoutAt: undefined,
        tags: ["t1"],
      } as any);

      const token = H.createManualWaitpoint.mock.calls[0][0];
      expect({ residency: token.standaloneResidency, shardKey: token.standaloneShardKey }).toEqual({
        residency: placement.residency,
        shardKey: placement.shardKey,
      });
      const tag = H.createWaitpointTag.mock.calls[0][0];
      expect({ residency: tag.residency, shardKey: tag.shardKey }).toEqual({
        residency: placement.residency,
        shardKey: placement.shardKey,
      });

      // The store look-up runs only with the waitpoint flag on, so turn it on to see its placement.
      H.storeEnabled = true;
      await webhookWaitpoints.find({ environmentId: H.environment.id, idempotencyKey: "key_1" });

      expect(H.findWaitpoint.mock.calls[0][2]).toEqual(
        placement.shard === "a" ? undefined : { residency: placement.residency }
      );
      const lookup = H.readExistingStoreDateTimeWaitpointByKey.mock.calls[0][0];
      expect({
        residency: lookup.standaloneResidency,
        shardKey: lookup.standaloneShardKey,
      }).toEqual({ residency: placement.residency, shardKey: placement.shardKey });
    }
  });
});
