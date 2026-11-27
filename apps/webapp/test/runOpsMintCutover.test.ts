// Per-env run-ops-id mint cutover integration proof.
//
// NEVER mocks the DB: the mint decision runs through the pure core `computeRunIdMintKind`
// wired to a REAL `makeFlag(prisma)` that reads the REAL `Organization.featureFlags` /
// `FeatureFlag` rows in a testcontainers Postgres. Only the two boundary knobs
// are injected — `masterEnabled` and the `splitEnabled` boot-boolean — never a
// mocked DB. The run-ops-id/cuid format + residency are then proven through the SAME isomorphic
// helpers the real trigger path uses (`generateRunOpsId` / `RunId.toFriendlyId` /
// `RunId.fromFriendlyId` / `ownerEngine`).
import type { PrismaClient } from "@trigger.dev/database";
import {
  BatchId,
  generateRunOpsId,
  generateRunOpsIdV2,
  ownerEngine,
  RunId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import {
  MEMORYDB_SHARD_KEY,
  organizationContext,
  PostgresRunStore,
  RoutingRunStore,
  type CreateRunInput,
} from "@internal/run-store";
import { makeNShardRunOpsPostgresTest, postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

// The admin writers and the gate run for real against the test's control-plane database; only the
// session, the admin token, the run store singletons and the resolver singleton's invalidation are
// replaced. The cases above pass their own client and read nothing through these mocks.
const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/db.server", async () => {
  const { boundedIn, $transaction: transaction } = await import("@trigger.dev/database");
  const client = new Proxy(
    {},
    {
      get(_target, prop) {
        const value = (db.client as any)[prop];
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    }
  );
  // The global flags route stamps inside a named transaction.
  const $transaction = (prisma: any, fnOrName: any, fnOrOptions?: any) =>
    transaction(prisma, typeof fnOrName === "string" ? fnOrOptions : fnOrName, () => {});
  return { prisma: client, $replica: client, boundedIn, $transaction };
});

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_admin", admin: true }),
}));

vi.mock("~/services/personalAccessToken.server", () => ({
  requireAdminApiRequest: async () => ({ id: "user_admin", admin: true }),
}));

// The real module builds the run store singletons at import, which open Redis connections.
vi.mock("~/v3/runStore.server", () => ({ memoryDbStoreRegistered: () => false }));

vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  controlPlaneResolver: { invalidateOrganization: () => {} },
}));

import {
  computeRunIdMintKind,
  type RunIdMintKind,
} from "~/v3/runOpsMigration/runOpsMintKind.server";
import { env } from "~/env.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { action as globalFlagsAction } from "~/routes/admin.api.v1.feature-flags";
import { action as v1OrgFlagsAction } from "~/routes/admin.api.v1.orgs.$organizationId.feature-flags";
import {
  action as v2OrgFlagsAction,
  loader as v2OrgFlagsLoader,
} from "~/routes/admin.api.v2.orgs.$organizationId.feature-flags";
import { FEATURE_FLAG, getAllFlagControlTypes, type FeatureFlagKey } from "~/v3/featureFlags";
import { makeFlag, replaceGlobalFeatureFlags } from "~/v3/featureFlags.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { mintFriendlyIdForKind } from "~/v3/runOpsMigration/mintAnchoredRunFriendlyId.server";
import { mintBatchFriendlyId } from "~/v3/runOpsMigration/mintBatchFriendlyId.server";
import { createRootResidencyDecision } from "~/v3/runOpsMigration/resolveRootResidency.server";
import { resolveRunMintTarget } from "~/v3/runOpsMigration/resolveRunMintTarget.server";
import { createRunResidencyAllowedResolver } from "~/v3/utils/runResidency.server";
import { createRunResidencyGate } from "~/v3/utils/runResidencyGate.server";
import {
  createTestOrgProjectWithMember,
  createRuntimeEnvironment,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// The real trigger-path mint helper, copied verbatim from triggerTask.server.ts so the
// test exercises the exact id format a cut-over env produces.
function mintRunOpsFriendlyId(): string {
  return RunId.toFriendlyId(generateRunOpsId());
}

// Mirrors the real trigger path: resolve the kind, then mint either a run-ops friendlyId or
// the default cuid one (RunId.generate()).
function mintRunFriendlyId(kind: RunIdMintKind): string {
  return kind === "runOpsId" ? mintRunOpsFriendlyId() : RunId.generate().friendlyId;
}

async function seedOrgEnv(prisma: PrismaClient, mintFlag?: RunIdMintKind) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  if (mintFlag) {
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { [FEATURE_FLAG.runOpsMintKind]: mintFlag } },
    });
  }
  return { organization, environment };
}

// Build the env-bound `flag` dependency around a REAL makeFlag(prisma) reading the real
// Organization.featureFlags override store. Pure-core gets the real DB-backed flag; only
// masterEnabled + splitEnabled are injected boundary config.
function realFlag(prisma: PrismaClient) {
  const flagFn = makeFlag(prisma);
  return async (orgId: string, orgFeatureFlags: unknown | undefined): Promise<RunIdMintKind> => {
    const overrides =
      orgFeatureFlags !== undefined
        ? orgFeatureFlags
        : (
            await prisma.organization.findFirst({
              where: { id: orgId },
              select: { featureFlags: true },
            })
          )?.featureFlags;
    return flagFn({
      key: FEATURE_FLAG.runOpsMintKind,
      defaultValue: "cuid",
      overrides: (overrides as Record<string, unknown>) ?? {},
    });
  };
}

describe("per-env run-ops-id mint cutover", () => {
  postgresTest(
    "canary org mints run-ops/NEW; non-canary org mints cuid/LEGACY",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "runOpsId"); // canary
      const b = await seedOrgEnv(prisma); // not cut over

      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      const kindA = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const kindB = await computeRunIdMintKind(
        { organizationId: b.organization.id, id: b.environment.id },
        deps
      );

      expect(kindA).toBe("runOpsId");
      expect(kindB).toBe("cuid");

      const friendlyA = mintRunFriendlyId(kindA);
      const friendlyB = mintRunFriendlyId(kindB);

      expect(RunId.fromFriendlyId(friendlyA).length).toBe(26);
      expect(ownerEngine(RunId.fromFriendlyId(friendlyA))).toBe("NEW");

      expect(RunId.fromFriendlyId(friendlyB).length).toBe(25);
      expect(ownerEngine(RunId.fromFriendlyId(friendlyB))).toBe("LEGACY");
    }
  );

  postgresTest(
    "split OFF mints cuid even for a 'runOpsId'-flagged org (split gate dominates)",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "runOpsId");
      const flag = vi.fn(realFlag(prisma));

      const kind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        { masterEnabled: true, splitEnabled: async () => false, flag }
      );

      expect(kind).toBe("cuid");
      expect(flag).not.toHaveBeenCalled(); // gated off before any DB read
    }
  );

  postgresTest(
    "drain-new-forward (D8): flipping back to cuid stops new run-ops mints without reverting existing",
    async ({ prisma }) => {
      const a = await seedOrgEnv(prisma, "runOpsId");
      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      // First run is born run-ops/NEW while cut over.
      const firstKind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const firstFriendly = mintRunFriendlyId(firstKind);
      expect(firstKind).toBe("runOpsId");
      expect(ownerEngine(RunId.fromFriendlyId(firstFriendly))).toBe("NEW");

      // Roll the org back to cuid (drain-new-forward — set the flag to "cuid").
      await prisma.organization.update({
        where: { id: a.organization.id },
        data: { featureFlags: { [FEATURE_FLAG.runOpsMintKind]: "cuid" } },
      });

      // The NEXT run mints cuid again (the env-bound resolver's TTL cache is not used here,
      // so the flip is observed immediately — production waits one cache TTL).
      const nextKind = await computeRunIdMintKind(
        { organizationId: a.organization.id, id: a.environment.id },
        deps
      );
      const nextFriendly = mintRunFriendlyId(nextKind);
      expect(nextKind).toBe("cuid");
      expect(ownerEngine(RunId.fromFriendlyId(nextFriendly))).toBe("LEGACY");

      // The already-minted run-ops run is untouched — drain-new-forward never reverts it.
      expect(RunId.fromFriendlyId(firstFriendly).length).toBe(26);
      expect(ownerEngine(RunId.fromFriendlyId(firstFriendly))).toBe("NEW");
    }
  );

  postgresTest(
    "parent and child re-resolve independently from their own org flag",
    async ({ prisma }) => {
      // Parent lives in a cut-over org; child is triggered into a NON-cut-over org.
      const parentOrg = await seedOrgEnv(prisma, "runOpsId");
      const childOrg = await seedOrgEnv(prisma); // not cut over
      const flag = realFlag(prisma);
      const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

      const parentKind = await computeRunIdMintKind(
        { organizationId: parentOrg.organization.id, id: parentOrg.environment.id },
        deps
      );
      const childKind = await computeRunIdMintKind(
        { organizationId: childOrg.organization.id, id: childOrg.environment.id },
        deps
      );

      // Observed behavior: the mint decision is resolved per the run's OWN org/env flag —
      // it does NOT inherit the parent's residency. A child in a non-cut-over org mints cuid
      // even when its parent was born run-ops. If children must inherit, that inheritance
      // belongs to the child-trigger path, not this resolver.
      expect(parentKind).toBe("runOpsId");
      expect(childKind).toBe("cuid");
    }
  );
});

// ---- Runs born under the MemoryDB key, with a counting stand-in store under `m` on a database of
// its own, the real gate and the real root decision, while the residency switch is changed through
// the real admin writers. Nothing listens at the two store URLs, so both stores are down throughout.
const cutoverTest = makeNShardRunOpsPostgresTest(2);

const TASK = "cutover-task";
const GRACE_MS = env.RUN_OPS_MINT_FLIP_GRACE_MS;
const STORES_DOWN = {
  RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: "redis://127.0.0.1:1",
  RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: "redis://127.0.0.1:1",
  REALTIME_BACKEND_NATIVE_ENABLED: "1",
  REALTIME_BACKEND_DEFAULT: "native",
  TRIGGER_MOLLIFIER_ENABLED: "0",
};
// The enrolment rule's organisation flags, without the switch.
const RULE_FLAGS = {
  activeRunStoreEnabled: true,
  checkpointStoreEnabled: true,
  clickhouseFeedEnabled: true,
  waitpointStoreEnabled: true,
  realtimeNativeOnly: true,
  realtimeBackend: "native",
};
const SIMPLE = { keyed: false, token: false, delayed: false, debounced: false };
const STATUSES = [
  "PENDING",
  "PENDING_VERSION",
  "WAITING_FOR_DEPLOY",
  "DEQUEUED",
  "EXECUTING",
  "WAITING_TO_RESUME",
  "RETRYING_AFTER_FAILURE",
  "PAUSED",
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
] as const;
// The routing store's id-less methods (the statement record's list).
const APPENDIX_E = [
  "findRun",
  "findRunOnPrimary",
  "findRunOrThrow",
  "findRuns",
  "findRunsByIdempotencyKeys",
  "clearIdempotencyKey",
  "findTaskRunAttempt",
  "findExecutionSnapshot",
  "findManyExecutionSnapshots",
  "findSnapshotCompletedWaitpointIds",
  "findSnapshotCompletedWaitpointIdsWithPresence",
  "findWaitpointConnectedRunIds",
  "countPendingWaitpoints",
  "countPendingWaitpointsWithPresence",
  "findWaitpoint",
  "findManyWaitpoints",
  "findManyTaskRunWaitpoints",
  "deleteManyTaskRunWaitpoints",
  "findBatchTaskRunById",
  "findBatchTaskRunByFriendlyId",
  "findBatchTaskRunByIdempotencyKey",
  "updateManyBatchTaskRun",
  "findManyWaitpointTags",
];

// cuid, gen1, or gen2:<shard key>, from an id's 26-character body.
function shape(friendlyId: string): string {
  const body = friendlyId.slice(friendlyId.indexOf("_") + 1);
  if (body.length !== 26) return "cuid";
  return body[25] === "1" ? "gen1" : `gen2:${body[24]}`;
}

type Ids = { runtimeEnvironmentId: string; organizationId: string; projectId: string };

// runOpsStore.nShardMatrix.test.ts's buildRun, with the friendly id of the run id and extra fields.
function buildRun(
  params: Ids & { runId: string; extra?: Partial<CreateRunInput["data"]> }
): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: RunId.toFriendlyId(params.runId),
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: TASK,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: `task/${TASK}`,
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      ...params.extra,
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

function adminRequest(path: string, body?: unknown) {
  return new Request(`https://test.trigger.dev${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function dbNowMs(prisma: PrismaClient) {
  const [{ now }] = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return now.getTime();
}

// The four databases, the router with the stand-in under m and the real gate, and the decision.
async function cutoverWorld({ legacyPrisma, newPrisma, shardPrismas }: any) {
  db.client = legacyPrisma;
  const { organization, project } = await createTestOrgProjectWithMember(legacyPrisma);
  const environment = await createRuntimeEnvironment(legacyPrisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const ids: Ids = {
    runtimeEnvironmentId: environment.id,
    organizationId: organization.id,
    projectId: project.id,
  };
  const store = (prisma: unknown, schemaVariant: "legacy" | "dedicated") =>
    new PostgresRunStore({
      prisma: prisma as never,
      readOnlyPrisma: prisma as never,
      schemaVariant,
    });

  const standInPrisma = shardPrismas[1];
  const standInTarget = store(standInPrisma, "dedicated");
  const standInLog: string[] = [];
  const standIn = new Proxy(standInTarget, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof value !== "function") return value;
      return (...callArgs: unknown[]) => {
        standInLog.push(String(prop));
        return value.apply(target, callArgs);
      };
    },
  });

  // A fresh cache after each flag change, as a production cache entry expires.
  const newResolver = () =>
    new ControlPlaneResolver({
      controlPlanePrimary: legacyPrisma,
      controlPlaneReplica: legacyPrisma,
      cache: new ControlPlaneCache(),
      splitEnabled: () => true,
    });
  let resolver = newResolver();
  const lookups: string[] = [];
  const router = new RoutingRunStore({
    new: store(newPrisma, "dedicated"),
    legacy: store(legacyPrisma, "legacy"),
    shards: [
      { key: "a", store: store(shardPrismas[0], "dedicated") },
      { key: MEMORYDB_SHARD_KEY, store: standIn },
    ],
    memoryDbGate: createRunResidencyGate({
      readGlobalFlags: () => globalFlagsRegistry.current(),
      resolveAuthenticatedEnv: (environmentId) => {
        lookups.push(environmentId);
        return resolver.resolveAuthenticatedEnv(environmentId);
      },
    }),
  });

  const decision = createRootResidencyDecision({
    isResidencyAllowed: (flags) =>
      createRunResidencyAllowedResolver({
        env: STORES_DOWN,
        isSplitEnabled: async () => true,
        readGlobalFlags: () => globalFlagsRegistry.current(),
        graceMs: GRACE_MS,
      })(flags),
    readGlobalFlags: () => globalFlagsRegistry.current(),
    readUnsupportedGroups: () => [],
    memoryDbStoreRegistered: () => true,
  });

  const storedFlags = async () =>
    (
      await legacyPrisma.organization.findFirstOrThrow({
        where: { id: organization.id },
        select: { featureFlags: true },
      })
    ).featureFlags as Record<string, any>;
  // As a request's authenticated environment carries them.
  const requestFlags = async () =>
    (await findEnvironmentById(environment.id))!.organization.featureFlags;
  const mintEnvironment = (flags: unknown) => ({
    organizationId: organization.id,
    id: environment.id,
    orgFeatureFlags: flags,
  });

  const w = {
    legacyPrisma: legacyPrisma as PrismaClient,
    standInPrisma,
    standInTarget,
    standInLog,
    lookups,
    router,
    ids,
    environment,
    storedFlags,
    async refresh() {
      await globalFlagsRegistry.reload();
      resolver = newResolver();
    },
    async setFlags(flags: Record<string, unknown>) {
      await legacyPrisma.organization.update({
        where: { id: organization.id },
        data: { featureFlags: flags },
      });
      await w.refresh();
    },
    // A change through a real admin writer; the database clock around it.
    // A change through a real admin writer, with the process clock in 2001, so a stored change
    // time between the database clock readings around it came from the database.
    async change(write: () => Promise<Response>) {
      const before = await dbNowMs(legacyPrisma);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2001-01-01T00:00:00.000Z"));
      let res: Response;
      try {
        res = await write();
      } finally {
        vi.useRealTimers();
      }
      expect({
        status: res.status,
        error: res.status === 200 ? undefined : await res.text(),
      }).toEqual({
        status: 200,
        error: undefined,
      });
      const after = await dbNowMs(legacyPrisma);
      await w.refresh();
      return { before, after };
    },
    v1: (body: Record<string, unknown>) =>
      (v1OrgFlagsAction as any)({
        request: adminRequest(`/admin/api/v1/orgs/${organization.id}/feature-flags`, body),
        params: { organizationId: organization.id },
        context: {},
      }) as Promise<Response>,
    async v2WithoutSwitch() {
      const loaded = await (
        (await (v2OrgFlagsLoader as any)({
          request: adminRequest(`/admin/api/v2/orgs/${organization.id}/feature-flags`),
          params: { organizationId: organization.id },
          context: {},
        })) as Response
      ).json();
      const { runResidencyEnabled: _removed, ...rest } = loaded.orgFlags;
      return (await (v2OrgFlagsAction as any)({
        request: adminRequest(`/admin/api/v2/orgs/${organization.id}/feature-flags`, rest),
        params: { organizationId: organization.id },
        context: {},
      })) as Response;
    },
    // The global admin page's writer, saving the global flags without the switch.
    async globalPageWithoutSwitch() {
      const rows = await legacyPrisma.featureFlag.findMany({ select: { key: true, value: true } });
      const requestedFlags = Object.fromEntries(
        rows
          .filter((r: any) => !r.key.startsWith("runResidencyEnabled"))
          .map((r: any) => [r.key, r.value])
      );
      await replaceGlobalFeatureFlags(legacyPrisma, {
        requestedFlags,
        catalogKeys: Object.keys(getAllFlagControlTypes()) as FeatureFlagKey[],
        isManagedCloud: false,
        unlockLockedFlags: false,
        graceMs: GRACE_MS,
      });
      return new Response(null, { status: 200 });
    },
    async globalStamp() {
      const rows = await legacyPrisma.featureFlag.findMany({
        where: { key: { startsWith: "runResidencyEnabled" } },
        select: { key: true, value: true },
      });
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value])) as Record<string, any>;
    },
    global: (body: Record<string, unknown>) =>
      (globalFlagsAction as any)({
        request: adminRequest("/admin/api/v1/feature-flags", body),
        params: {},
        context: {},
      }) as Promise<Response>,
    // Moves every stored change time of the switch back by more than the grace.
    async pastGrace() {
      const flags = await storedFlags();
      if (typeof flags.runResidencyEnabledFlippedAt === "string") {
        flags.runResidencyEnabledFlippedAt = new Date(
          Date.parse(flags.runResidencyEnabledFlippedAt) - GRACE_MS - 1_000
        ).toISOString();
        await legacyPrisma.organization.update({
          where: { id: organization.id },
          data: { featureFlags: flags },
        });
      }
      const global = await legacyPrisma.featureFlag.findFirst({
        where: { key: "runResidencyEnabledFlippedAt" },
      });
      if (global && typeof global.value === "string") {
        await legacyPrisma.featureFlag.update({
          where: { key: global.key },
          data: { value: new Date(Date.parse(global.value) - GRACE_MS - 1_000).toISOString() },
        });
      }
      await w.refresh();
    },
    async inScope<T>(scope: "request" | "engine", fn: () => Promise<T>) {
      if (scope === "engine") return organizationContext.withEnvironment(environment.id, fn);
      const featureFlags = await requestFlags();
      return organizationContext.run(
        { organizationId: organization.id, environmentId: environment.id, featureFlags },
        fn
      );
    },
    todayShape: async () =>
      shape(
        mintFriendlyIdForKind(
          await resolveRunMintTarget({ environment: mintEnvironment(await requestFlags()) })
        )
      ),
    // A new simple root's id: the decision, then today's mint.
    async newSimpleRoot() {
      const flags = await requestFlags();
      return (await decision.allowsRootRun(flags, SIMPLE))
        ? mintFriendlyIdForKind({ kind: "runOpsId", shardChar: MEMORYDB_SHARD_KEY })
        : mintFriendlyIdForKind(
            await resolveRunMintTarget({ environment: mintEnvironment(flags) })
          );
    },
    childOf: async (parentRunFriendlyId: string) =>
      mintFriendlyIdForKind(
        await resolveRunMintTarget({
          environment: mintEnvironment(await requestFlags()),
          parentRunFriendlyId,
        })
      ),
    batchOf: async (parentRunFriendlyId: string) =>
      (
        await mintBatchFriendlyId({
          environment: mintEnvironment(await requestFlags()),
          parentRunFriendlyId,
        })
      ).friendlyId,
    create: (runId: string, extra?: Partial<CreateRunInput["data"]>) =>
      router.createRun(buildRun({ ...ids, runId, extra })),
  };
  return w;
}

type World = Awaited<ReturnType<typeof cutoverWorld>>;

// The rows the id-less calls read, all on the stand-in's database: the MemoryDB runs (one per
// status but DELAYED), and for the first of them an attempt, a snapshot that completed a standalone
// waitpoint W, an edge and a connection to W, a batch and a waitpoint tag. Its parent and its batch
// have cuid ids, so no predicate carries a generation 3 id.
async function seedMemoryDbRuns(w: World) {
  const S = w.standInPrisma;
  const { runtimeEnvironmentId: environmentId, projectId, organizationId } = w.ids;
  const parent = RunId.generate();
  await w.standInTarget.createRun(buildRun({ ...w.ids, runId: parent.id }));
  const batch = BatchId.generate();
  await S.batchTaskRun.create({
    data: {
      id: batch.id,
      friendlyId: batch.friendlyId,
      runtimeEnvironmentId: environmentId,
      status: "PENDING",
      runCount: 1,
      expectedCount: 1,
      batchVersion: "runengine:v2",
      idempotencyKey: "idless-batch-key",
    },
  });

  const runs: { id: string; friendlyId: string; status: string }[] = [];
  for (const status of STATUSES) {
    const friendlyId = await w.newSimpleRoot();
    expect({ status, shape: shape(friendlyId) }).toEqual({ status, shape: "gen2:m" });
    const id = RunId.fromFriendlyId(friendlyId);
    await w.create(
      id,
      runs.length === 0
        ? {
            spanId: "idless-span",
            parentSpanId: "idless-parent-span",
            parentTaskRunId: parent.id,
            idempotencyKey: "idless-key",
            batchId: batch.id,
          }
        : undefined
    );
    await S.taskRun.update({ where: { id }, data: { status } });
    runs.push({ id, friendlyId, status });
  }
  const x = runs[0]!.id;

  const attempt = "attempt_idless";
  await S.taskRunAttempt.create({
    data: {
      friendlyId: attempt,
      number: 1,
      taskRunId: x,
      backgroundWorkerId: "worker_idless",
      backgroundWorkerTaskId: "worker_task_idless",
      runtimeEnvironmentId: environmentId,
      queueId: "queue_idless",
      status: "EXECUTING",
    },
  });
  const waitpoint = WaitpointId.generate();
  await S.waitpoint.create({
    data: {
      id: waitpoint.id,
      friendlyId: waitpoint.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: "idless-waitpoint",
      userProvidedIdempotencyKey: false,
      projectId,
      environmentId,
    },
  });
  const snapshot = await S.taskRunExecutionSnapshot.create({
    data: {
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "seeded",
      runId: x,
      runStatus: "EXECUTING",
      environmentId,
      environmentType: "PRODUCTION",
      projectId,
      organizationId,
    },
  });
  await S.completedWaitpoint.create({
    data: { snapshotId: snapshot.id, waitpointId: waitpoint.id },
  });
  await S.taskRunWaitpoint.create({ data: { taskRunId: x, waitpointId: waitpoint.id, projectId } });
  await S.waitpointRunConnection.create({ data: { taskRunId: x, waitpointId: waitpoint.id } });
  await S.waitpointTag.create({ data: { name: "idless-tag", environmentId, projectId } });

  return {
    runs,
    x,
    parent: parent.id,
    batch,
    attempt,
    waitpoint: waitpoint.id,
    snapshot: snapshot.id,
  };
}

type Seeded = Awaited<ReturnType<typeof seedMemoryDbRuns>>;

// Each id-less read's answer when the stand-in's rows are not reached. findRunOrThrow rejects instead.
const IDLESS_MISS: Record<string, unknown> = {
  findRun: null,
  findRunOnPrimary: null,
  findRuns: [],
  findRunsByIdempotencyKeys: [],
  findTaskRunAttempt: null,
  findExecutionSnapshot: null,
  findManyExecutionSnapshots: [],
  findSnapshotCompletedWaitpointIds: [],
  findSnapshotCompletedWaitpointIdsWithPresence: { present: false, ids: [] },
  findWaitpointConnectedRunIds: [],
  countPendingWaitpoints: 0,
  countPendingWaitpointsWithPresence: { pendingIds: [], presentIds: [] },
  findWaitpoint: null,
  findManyWaitpoints: [],
  findManyTaskRunWaitpoints: [],
  findBatchTaskRunById: null,
  findBatchTaskRunByFriendlyId: null,
  findBatchTaskRunByIdempotencyKey: null,
  findManyWaitpointTags: [],
};

// A call's answer, or its error as Prisma's code (when it has one) or message.
function idlessOutcome(c: { answer?: unknown; error?: unknown }) {
  if (c.error === undefined) return { answer: c.answer };
  const e = c.error as { code?: string; message?: string };
  return { error: e.code ?? e.message ?? String(c.error) };
}
type IdlessCall = [
  method: string,
  label: string,
  call: (store: any) => Promise<unknown>,
  holds?: (answer: any) => boolean,
];

// The statement record's id-less calls, aimed at the environment; the writes match no seeded row.
function idlessCalls(w: World, s: Seeded, legacyRunId: string): IdlessCall[] {
  const environmentId = w.ids.runtimeEnvironmentId;
  const select = { select: { id: true, friendlyId: true } };
  const isX = (a: any) => a?.id === s.x;
  const hasX = (a: any) => Array.isArray(a) && a.some((r: any) => r.id === s.x);
  const hasW = (a: any) => Array.isArray(a) && a.some((r: any) => r.id === s.waitpoint);
  const calls: IdlessCall[] = [];
  for (const [label, where] of [
    ["span id", { spanId: "idless-span" }],
    ["parent span id", { parentSpanId: "idless-parent-span" }],
    ["parent", { parentTaskRunId: { in: [s.parent] } }],
    ["batch", { batchId: { in: [s.batch.id] } }],
    ["idempotency key", { idempotencyKey: "idless-key", runtimeEnvironmentId: environmentId }],
  ] as const) {
    calls.push(
      ["findRun", `findRun by ${label}`, (st) => st.findRun(where, select), isX],
      [
        "findRunOnPrimary",
        `findRunOnPrimary by ${label}`,
        (st) => st.findRunOnPrimary(where, select),
        isX,
      ],
      [
        "findRunOrThrow",
        `findRunOrThrow by ${label}`,
        (st) => st.findRunOrThrow(where, select),
        isX,
      ],
      [
        "findRuns",
        `findRuns by ${label}`,
        (st) => st.findRuns({ where, select: { id: true }, orderBy: { id: "asc" } }),
        hasX,
      ]
    );
  }
  const waitpointWhere = { environmentId, type: "MANUAL" as const };
  calls.push(
    [
      "findRunsByIdempotencyKeys",
      "findRunsByIdempotencyKeys",
      (st) =>
        st.findRunsByIdempotencyKeys({
          runtimeEnvironmentId: environmentId,
          taskIdentifier: TASK,
          idempotencyKeys: ["idless-key"],
        }),
      hasX,
    ],
    [
      "findTaskRunAttempt",
      "findTaskRunAttempt by attempt id",
      (st) =>
        st.findTaskRunAttempt({
          where: { friendlyId: s.attempt },
          select: { id: true, friendlyId: true },
        }),
      (a) => a?.friendlyId === s.attempt,
    ],
    [
      "findExecutionSnapshot",
      "findExecutionSnapshot without a run id",
      (st) =>
        st.findExecutionSnapshot({
          where: { environmentId, executionStatus: "EXECUTING" },
          select: { id: true, runId: true },
          orderBy: { createdAt: "asc" },
        }),
      (a) => a?.id === s.snapshot,
    ],
    [
      "findManyExecutionSnapshots",
      "findManyExecutionSnapshots without a run id",
      (st) =>
        st.findManyExecutionSnapshots({
          where: { environmentId, executionStatus: "EXECUTING" },
          select: { id: true, runId: true },
          orderBy: { id: "asc" },
        }),
      (a) => a.some((r: any) => r.id === s.snapshot),
    ],
    [
      "findSnapshotCompletedWaitpointIds",
      "findSnapshotCompletedWaitpointIds",
      (st) => st.findSnapshotCompletedWaitpointIds(s.snapshot),
      (a) => a.includes(s.waitpoint),
    ],
    [
      "findSnapshotCompletedWaitpointIdsWithPresence",
      "findSnapshotCompletedWaitpointIdsWithPresence",
      (st) => st.findSnapshotCompletedWaitpointIdsWithPresence(s.snapshot),
      (a) => a.present === true && a.ids.includes(s.waitpoint),
    ],
    [
      "findWaitpointConnectedRunIds",
      "findWaitpointConnectedRunIds",
      (st) => st.findWaitpointConnectedRunIds(s.waitpoint),
      (a) => a.includes(s.x),
    ],
    [
      "countPendingWaitpoints",
      "countPendingWaitpoints without a run id",
      (st) => st.countPendingWaitpoints([s.waitpoint]),
      (a) => a === 1,
    ],
    [
      "countPendingWaitpointsWithPresence",
      "countPendingWaitpointsWithPresence without a run id",
      (st) => st.countPendingWaitpointsWithPresence([s.waitpoint]),
      (a) => a.presentIds.includes(s.waitpoint),
    ],
    [
      "findWaitpoint",
      "findWaitpoint with no id and no co-location",
      (st) => st.findWaitpoint({ where: waitpointWhere, select: { id: true } }),
      (a) => a?.id === s.waitpoint,
    ],
    [
      "findManyWaitpoints",
      "findManyWaitpoints without a run id",
      (st) =>
        st.findManyWaitpoints({
          where: waitpointWhere,
          select: { id: true },
          orderBy: { id: "asc" },
        }),
      hasW,
    ],
    [
      "findManyWaitpoints",
      "findManyWaitpoints with a run id and no waitpoint ids",
      (st) =>
        st.findManyWaitpoints(
          { where: waitpointWhere, select: { id: true }, orderBy: { id: "asc" } },
          undefined,
          legacyRunId
        ),
      hasW,
    ],
    [
      "findManyTaskRunWaitpoints",
      "findManyTaskRunWaitpoints without a run id",
      (st) =>
        st.findManyTaskRunWaitpoints({
          where: { projectId: w.ids.projectId },
          select: { taskRunId: true, waitpointId: true },
          orderBy: { taskRunId: "asc" },
        }),
      (a) => a.some((e: any) => e.taskRunId === s.x && e.waitpointId === s.waitpoint),
    ],
    [
      "findBatchTaskRunById",
      "findBatchTaskRunById",
      (st) => st.findBatchTaskRunById(s.batch.id),
      (a) => a?.id === s.batch.id,
    ],
    [
      "findBatchTaskRunByFriendlyId",
      "findBatchTaskRunByFriendlyId",
      (st) => st.findBatchTaskRunByFriendlyId(s.batch.friendlyId, environmentId),
      (a) => a?.id === s.batch.id,
    ],
    [
      "findBatchTaskRunByIdempotencyKey",
      "findBatchTaskRunByIdempotencyKey",
      (st) => st.findBatchTaskRunByIdempotencyKey(environmentId, "idless-batch-key"),
      (a) => a?.id === s.batch.id,
    ],
    [
      "findManyWaitpointTags",
      "findManyWaitpointTags",
      (st) => st.findManyWaitpointTags({ where: { environmentId }, orderBy: { name: "asc" } }),
      (a) => a.some((t: any) => t.name === "idless-tag"),
    ],
    [
      "updateManyBatchTaskRun",
      "updateManyBatchTaskRun by predicate",
      (st) =>
        st.updateManyBatchTaskRun({
          where: { runtimeEnvironmentId: environmentId, idempotencyKey: "no-such-batch-key" },
          data: { sealed: true },
        }),
    ],
    [
      "deleteManyTaskRunWaitpoints",
      "deleteManyTaskRunWaitpoints by waitpoint",
      (st) => st.deleteManyTaskRunWaitpoints({ where: { waitpointId: WaitpointId.generate().id } }),
    ],
    [
      "clearIdempotencyKey",
      "clearIdempotencyKey by predicate",
      (st) =>
        st.clearIdempotencyKey({
          byPredicate: {
            idempotencyKey: "no-such-key",
            taskIdentifier: TASK,
            runtimeEnvironmentId: environmentId,
          },
        }),
    ],
    [
      "clearIdempotencyKey",
      "clearIdempotencyKey byFriendlyIds",
      (st) => st.clearIdempotencyKey({ byFriendlyIds: [RunId.generate().friendlyId] }),
    ]
  );
  return calls;
}

// Each id-less call in one scope: whether it asked the stand-in, its answer or error, and whether
// its answer holds the stand-in's row; then findRuns over the environment; and the gate's look-ups.
async function idlessPass(w: World, s: Seeded, legacyRunId: string, scope: "request" | "engine") {
  w.lookups.length = 0;
  const calls: {
    method: string;
    label: string;
    asked: boolean;
    write: boolean;
    answer?: unknown;
    error?: unknown;
    holds?: boolean;
  }[] = [];
  let listed: string[] = [];
  await w.inScope(scope, async () => {
    for (const [method, label, call, holds] of idlessCalls(w, s, legacyRunId)) {
      w.standInLog.length = 0;
      let answer: unknown;
      let error: unknown;
      try {
        answer = await call(w.router);
      } catch (caught) {
        error = caught ?? new Error("rejected with no reason");
      }
      calls.push({
        method,
        label,
        asked: w.standInLog.length > 0,
        write: !holds,
        ...(error === undefined ? { answer } : { error }),
        ...(holds ? { holds: error === undefined && holds(answer) } : {}),
      });
    }
    const rows = await w.router.findRuns({
      where: { runtimeEnvironmentId: w.ids.runtimeEnvironmentId },
      select: { id: true },
    });
    listed = rows.map((r: { id: string }) => r.id).sort();
  });
  return { calls, listed, lookups: [...w.lookups] };
}

describe("runs born under the MemoryDB key across residency switch changes", () => {
  // Catches: a MemoryDB run unreached, or a root born there, after a switch or run record change.
  cutoverTest(
    "toggling: MemoryDB runs stay reached by id and by id-less reads in both scopes",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const w = await cutoverWorld({ legacyPrisma, newPrisma, shardPrismas });
      await w.setFlags(RULE_FLAGS);
      const older = [RunId.generate().id, generateRunOpsId(), generateRunOpsIdV2("a")];
      for (const id of older) await w.create(id);
      const [legacyRunId] = older as [string];
      expect(older.map((id) => shape(RunId.toFriendlyId(id)))).toEqual(["cuid", "gen1", "gen2:a"]);
      const today = await w.todayShape();
      expect(today).not.toBe("gen2:m");

      let seeded: Seeded | undefined;
      let stamp: Record<string, unknown> = {};
      const expectStamp = async (
        step: string,
        prev: boolean,
        clock?: { before: number; after: number }
      ) => {
        const stored = await w.storedFlags();
        const flippedAtMs = Date.parse(stored.runResidencyEnabledFlippedAt);
        expect({ step, prev: stored.runResidencyEnabledPrev }).toEqual({ step, prev });
        if (clock) {
          // A change time from the database clock.
          expect({
            step,
            within: flippedAtMs >= clock.before && flippedAtMs <= clock.after,
          }).toEqual({
            step,
            within: true,
          });
        } else {
          // Kept: the change time before the step.
          expect({ step, flippedAt: stored.runResidencyEnabledFlippedAt }).toEqual({
            step,
            flippedAt: stamp.runResidencyEnabledFlippedAt,
          });
        }
      };
      const remember = async () => {
        const stored = await w.storedFlags();
        stamp = {
          runResidencyEnabledPrev: stored.runResidencyEnabledPrev,
          runResidencyEnabledFlippedAt: stored.runResidencyEnabledFlippedAt,
        };
      };

      const checkStep = async (step: string, opts: { root: "gen3" | "today"; open: boolean }) => {
        const s = seeded!;
        expect({ step, root: shape(await w.newSimpleRoot()) }).toEqual({
          step,
          root: opts.root === "gen3" ? "gen2:m" : today,
        });

        w.standInLog.length = 0;
        const byId: Record<string, unknown> = {};
        for (const id of [...older, ...s.runs.map((r) => r.id)]) {
          byId[id] = await w.router.findRun({ id }, { select: { id: true, status: true } });
        }
        expect({ step, byId }).toEqual({
          step,
          byId: Object.fromEntries([
            ...older.map((id) => [id, { id, status: "PENDING" }]),
            ...s.runs.map((r) => [r.id, { id: r.id, status: r.status }]),
          ]),
        });
        // A MemoryDB run is read from the store under m by its id.
        expect({ step, standIn: w.standInLog }).toEqual({
          step,
          standIn: s.runs.map(() => "findRun"),
        });

        const listedOpen = [...older, s.parent, ...s.runs.map((r) => r.id)].sort();
        for (const scope of ["request", "engine"] as const) {
          const pass = await idlessPass(w, s, legacyRunId, scope);
          const lookups = scope === "engine" ? [w.ids.runtimeEnvironmentId] : [];
          // The writes match no row, so each summed write resolves a count of 0, open or closed.
          const writes = pass.calls.filter((c) => c.write);
          expect({
            step,
            scope,
            writes: Object.fromEntries(writes.map((c) => [c.label, idlessOutcome(c)])),
          }).toEqual({
            step,
            scope,
            writes: Object.fromEntries(writes.map((c) => [c.label, { answer: { count: 0 } }])),
          });
          if (opts.open) {
            expect({
              step,
              scope,
              notAsked: pass.calls.filter((c) => !c.asked).map((c) => c.label),
              notHeld: pass.calls.filter((c) => c.holds === false).map((c) => c.label),
              methods: [...new Set(pass.calls.map((c) => c.method))].sort(),
              listed: pass.listed,
              lookups: pass.lookups,
            }).toEqual({
              step,
              scope,
              notAsked: [],
              notHeld: [],
              methods: [...APPENDIX_E].sort(),
              listed: listedOpen,
              lookups,
            });
          } else {
            // Closed: each read gives its normal miss; only findRunOrThrow rejects, with not found.
            const reads = pass.calls.filter((c) => !c.write);
            expect({
              step,
              scope,
              asked: pass.calls.filter((c) => c.asked).map((c) => c.label),
              reads: Object.fromEntries(reads.map((c) => [c.label, idlessOutcome(c)])),
              listed: pass.listed,
              lookups: pass.lookups,
            }).toEqual({
              step,
              scope,
              asked: [],
              reads: Object.fromEntries(
                reads.map((c) => [
                  c.label,
                  c.method === "findRunOrThrow"
                    ? { error: "P2025" }
                    : { answer: IDLESS_MISS[c.method] },
                ])
              ),
              listed: [...older].sort(),
              lookups,
            });
          }
        }
      };

      const childAndBatch = async (step: string) => {
        const parent = seeded!.runs[0]!.friendlyId;
        expect({
          step,
          child: shape(await w.childOf(parent)),
          batch: shape(await w.batchOf(parent)),
        }).toEqual({ step, child: "gen2:m", batch: "gen2:m" });
      };

      // 1. Off to on.
      let clock = await w.change(() => w.v1({ runResidencyEnabled: true }));
      await expectStamp("1 on", false, clock);
      await w.pastGrace();
      expect(shape(await w.newSimpleRoot())).toBe("gen2:m");
      seeded = await seedMemoryDbRuns(w);
      await checkStep("1 on", { root: "gen3", open: true });
      await childAndBatch("1 on");

      // 2. On to off.
      clock = await w.change(() => w.v1({ runResidencyEnabled: false }));
      await expectStamp("2 off", true, clock);
      await w.pastGrace();
      await checkStep("2 off", { root: "today", open: true });

      // 3. Removed.
      await remember();
      await w.change(() => w.v2WithoutSwitch());
      expect("runResidencyEnabled" in (await w.storedFlags())).toBe(false);
      await expectStamp("3 removed", true);
      await w.pastGrace();
      await checkStep("3 removed", { root: "today", open: true });
      await childAndBatch("3 removed");

      // 4. On again.
      clock = await w.change(() => w.v1({ runResidencyEnabled: true }));
      await expectStamp("4 on again", false, clock);
      await w.pastGrace();
      await checkStep("4 on again", { root: "gen3", open: true });

      // 5. The run record flag off, with the switch on No admin route accepts the flag.
      await remember();
      await w.setFlags({ ...(await w.storedFlags()), activeRunStoreEnabled: false });
      await expectStamp("5 run record off", false);
      await checkStep("5 run record off", { root: "today", open: false });
      // The nested read takes the outer call's decision: a generation 3 run id opens it.
      for (const scope of ["request", "engine"] as const) {
        const edges = await w
          .inScope(scope, () =>
            w.router.findManyTaskRunWaitpoints({
              where: { taskRunId: seeded!.x },
              select: { taskRunId: true, waitpoint: { select: { id: true, status: true } } },
            })
          )
          .then(
            (rows) => rows.map((e: any) => ({ taskRunId: e.taskRunId, waitpoint: e.waitpoint })),
            (error: Error) => ({ threw: error.message })
          );
        expect(edges, `step 5 run record off, ${scope} scope`).toEqual([
          { taskRunId: seeded!.x, waitpoint: { id: seeded!.waitpoint, status: "PENDING" } },
        ]);
      }
      await w.setFlags({ ...(await w.storedFlags()), activeRunStoreEnabled: true });

      // 6. Off past its grace; then on, and off again inside the grace of that change to on.
      clock = await w.change(() => w.v1({ runResidencyEnabled: false }));
      await expectStamp("6 off", true, clock);
      await w.pastGrace();
      clock = await w.change(() => w.v1({ runResidencyEnabled: true }));
      await expectStamp("6 on", false, clock);
      clock = await w.change(() => w.v1({ runResidencyEnabled: false }));
      await expectStamp("6 off inside the grace", true, clock);
      await w.pastGrace();
      await checkStep("6 off inside the grace", { root: "today", open: true });

      // 7. Removed; the global value off; then an override of off equal to the global value.
      await remember();
      await w.change(() => w.v2WithoutSwitch());
      await w.change(() => w.global({ runResidencyEnabled: false }));
      await w.change(() => w.v1({ runResidencyEnabled: false }));
      expect((await w.storedFlags()).runResidencyEnabled).toBe(false);
      await expectStamp("7 override equal to the global value", true);
      await w.pastGrace();
      await checkStep("7 override equal to the global value", { root: "today", open: true });

      // 8. An on switch removed from the organisation's flags, instead of turned off. With no
      // override the global value (off) is read at once; the stamp records on, so the gate stays open.
      clock = await w.change(() => w.v1({ runResidencyEnabled: true }));
      await expectStamp("8 on", false, clock);
      await w.pastGrace();
      clock = await w.change(() => w.v2WithoutSwitch());
      expect("runResidencyEnabled" in (await w.storedFlags())).toBe(false);
      await expectStamp("8 on switch removed", true, clock);
      expect({ step: "8 inside the grace", root: shape(await w.newSimpleRoot()) }).toEqual({
        step: "8 inside the grace",
        root: today,
      });
      await w.pastGrace();
      await checkStep("8 on switch removed", { root: "today", open: true });

      // 9. The global value on, then removed through the global admin page's writer: inside the
      // removal's grace a new root still reads on; past it, today's id. The organisation carries no
      // switch and no stamp, so past the grace only the global stamp keeps the gate open.
      await w.setFlags(RULE_FLAGS);
      await w.change(() => w.global({ runResidencyEnabled: true }));
      await w.pastGrace();
      expect({ step: "9 global on", root: shape(await w.newSimpleRoot()) }).toEqual({
        step: "9 global on",
        root: "gen2:m",
      });
      clock = await w.change(() => w.globalPageWithoutSwitch());
      const removed = await w.globalStamp();
      const removedAtMs = Date.parse(removed.runResidencyEnabledFlippedAt);
      expect({
        step: "9 global switch removed",
        value: removed.runResidencyEnabled,
        prev: removed.runResidencyEnabledPrev,
        fromDbClock: removedAtMs >= clock.before && removedAtMs <= clock.after,
      }).toEqual({
        step: "9 global switch removed",
        value: undefined,
        prev: true,
        fromDbClock: true,
      });
      expect({ step: "9 inside the grace", root: shape(await w.newSimpleRoot()) }).toEqual({
        step: "9 inside the grace",
        root: "gen2:m",
      });
      await w.pastGrace();
      await checkStep("9 global switch removed", { root: "today", open: true });
    },
    600_000
  );

  // Catches: an id-less read or sum over four stores missing, doubling or wrongly counting a run.
  cutoverTest(
    "mixed data: one run and one batch on each of the four stores",
    async ({ legacyPrisma, newPrisma, shardPrismas }) => {
      const w = await cutoverWorld({ legacyPrisma, newPrisma, shardPrismas });
      await w.setFlags({ ...RULE_FLAGS, runResidencyEnabled: true });
      const environmentId = w.ids.runtimeEnvironmentId;
      const runIds = [
        RunId.generate().id,
        generateRunOpsId(),
        generateRunOpsIdV2("a"),
        RunId.fromFriendlyId(await w.newSimpleRoot()),
      ];
      expect(runIds.map((id) => shape(RunId.toFriendlyId(id)))).toEqual([
        "cuid",
        "gen1",
        "gen2:a",
        "gen2:m",
      ]);
      for (const id of runIds) await w.create(id, { idempotencyKey: "mixed-key" });
      for (const id of [
        BatchId.generate().id,
        generateRunOpsId(),
        generateRunOpsIdV2("a"),
        generateRunOpsIdV2(MEMORYDB_SHARD_KEY),
      ]) {
        await w.router.createBatchTaskRun({
          id,
          friendlyId: BatchId.toFriendlyId(id),
          runtimeEnvironmentId: environmentId,
          status: "PENDING",
          runCount: 1,
          expectedCount: 1,
          runIds: [],
          batchVersion: "runengine:v2",
          idempotencyKey: "mixed-batch-key",
          sealed: false,
        } as any);
      }
      const keyPredicate = {
        idempotencyKey: "mixed-key",
        taskIdentifier: TASK,
        runtimeEnvironmentId: environmentId,
      };
      const reads = () =>
        w.inScope("request", async () => {
          w.standInLog.length = 0;
          const byId = [];
          for (const id of runIds) {
            byId.push((await w.router.findRun({ id }, { select: { id: true } }))?.id ?? null);
          }
          const standInByIdCalls = w.standInLog.length;
          const ids = async (where: Record<string, unknown>) =>
            (await w.router.findRuns({ where, select: { id: true } }))
              .map((r: { id: string }) => r.id)
              .sort();
          return {
            byId,
            standInByIdCalls,
            environment: await ids({ runtimeEnvironmentId: environmentId }),
            idempotencyKey: await ids({
              idempotencyKey: "mixed-key",
              runtimeEnvironmentId: environmentId,
            }),
            cleared: (await w.router.clearIdempotencyKey({ byPredicate: keyPredicate })).count,
            batches: (
              await w.router.updateManyBatchTaskRun({
                where: { runtimeEnvironmentId: environmentId, idempotencyKey: "mixed-batch-key" },
                data: { sealed: true },
              })
            ).count,
          };
        });

      // The gate open (the switch on, the run record flag on): every store, each run once.
      const all = [...runIds].sort();
      expect(await reads()).toEqual({
        byId: runIds,
        standInByIdCalls: 1,
        environment: all,
        idempotencyKey: all,
        cleared: 4,
        batches: 4,
      });

      // Put the keys back, then close the gate with the run record flag.
      for (const client of [legacyPrisma, newPrisma, ...shardPrismas]) {
        await (client as any).taskRun.updateMany({
          where: { runtimeEnvironmentId: environmentId },
          data: { idempotencyKey: "mixed-key" },
        });
      }
      await w.setFlags({ ...RULE_FLAGS, runResidencyEnabled: true, activeRunStoreEnabled: false });
      const postgres = runIds.slice(0, 3).sort();
      expect(await reads()).toEqual({
        byId: runIds,
        standInByIdCalls: 1,
        environment: postgres,
        idempotencyKey: postgres,
        cleared: 3,
        batches: 3,
      });
    },
    300_000
  );
});
