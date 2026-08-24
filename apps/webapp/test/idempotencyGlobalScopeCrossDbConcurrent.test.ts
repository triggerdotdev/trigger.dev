// CONCURRENT cross-DB GLOBAL-scope idempotency dedup for the run-ops split: one global key triggered
// concurrently from two parents on DIFFERENT physical DBs still yields exactly ONE child.
//
// The hard case dedup fan-out alone cannot cover: both triggers' dedup probes run BEFORE either child
// is created, so each probe misses and the per-DB unique index on (runtimeEnvironmentId,
// taskIdentifier, idempotencyKey) cannot enforce cross-DB uniqueness. The Redis idempotency-claim
// primitive (claimOrAwait/publishClaim) is the cross-DB mutual-exclusion gate for global-scope keys
// while the split is active, regardless of the per-org mollifier flag: the claim loser resolves the
// winner by id across both DBs and returns it as a cached hit → one child.
//
// Setup: drives the REAL IdempotencyKeyConcern.handleTriggerRequest against a REAL two-physical-DB
// RoutingRunStore (heteroPostgresTest, never mocked on the read/dedup path) AND a REAL MollifierBuffer
// over a Redis testcontainer. SETNX arbitration runs for real — one claimant wins, the other pends
// and polls until the winner publishes; only the caller's create + publishClaim glue is played here.
//
// Determinism: the loser's contended claim genuinely returns "pending" (it has probed PG, missed, and
// is now blocked on the winner). A barrier opens on that real "pending" outcome so the winner holds
// its create+publish until both claimants contend, then publishes well inside the loser's poll
// deadline — so the loser resolves on every run, not on wall-clock luck.

import {
  heteroPostgresTest,
  network,
  redisContainer,
  redisOptions,
  type StartedNetwork,
  type StartedRedisContainer,
} from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { generateRunOpsId, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { MollifierBuffer } from "@trigger.dev/redis-worker";
import type { IdempotencyClaimResult } from "@trigger.dev/redis-worker";
import type { RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";

// hookTimeout is bumped because the per-test bufferHarness fixture closes a real Redis client
// (MollifierBuffer.close → redis.quit) during teardown, which can outrun the 10s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

// --- Module wiring -----------------------------------------------------------------------------
// Hoisted holders so the (import-time) mocks below can defer to per-test values.
const h = vi.hoisted(() => ({
  router: null as unknown,
  buffer: null as unknown,
  splitOn: true,
}));

// The concern reads `runStore` (module singleton) for both the id-less dedup probe and the
// by-id winner resolution. Point it at the per-test RoutingRunStore built over the two real
// containers.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = h.router as Record<string | symbol, unknown>;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }
  ),
}));

// Real claim algorithm (claimOrAwait/publishClaim) backed by a REAL MollifierBuffer over a Redis
// testcontainer (see buildRealBuffer). The read/dedup path (PG findRun) stays real too.
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => h.buffer,
}));

// Split ON so resolveIdempotencyDedupClient routes the dedup client by the parent's residency and
// runStore behaves as the RoutingRunStore.
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({
  isSplitEnabled: async () => h.splitOn,
}));

// The run-ops db.server handles are only ever used as the dedup-client SENTINEL under routing
// (their identity is never forwarded to a routed store — only their presence signals
// read-your-writes). Truthy placeholders suffice; the real containers are reached via the router.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: { __sentinel: "new" },
  runOpsLegacyPrisma: { __sentinel: "legacy" },
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { publishClaim } from "~/v3/mollifier/idempotencyClaim.server";
import type { TraceEventConcern, TriggerTaskRequest } from "~/runEngine/types";

// --- Real MollifierBuffer over Redis, instrumented for the barrier -----------------------------
// Builds the SAME MollifierBuffer the webapp uses (constructed with { redisOptions }), pointed at
// the per-test Redis container. The instrumentation is a thin observability wrapper only: it counts
// claim attempts and opens a barrier when a claim genuinely returns "pending" (a real SETNX loser).
// The SETNX itself, publishClaim and readClaim are the buffer's real Redis ops — nothing is faked.
type BufferHarness = {
  buffer: MollifierBuffer;
  secondClaimPending: Promise<void>;
  // Resolves once TWO claimants have genuinely returned "pending" — i.e. both
  // losers of a winner + two-loser trio have probed PG (missed) and are
  // blocked on the winner. Used by the EXPIRED/FAILED reacquire cases so the
  // winner holds its create+publish until BOTH losers contend, guaranteeing
  // both take the claim-loser path (not a PG hit) on the SAME resolved winner.
  bothLosersPending: Promise<void>;
  readonly claimCalls: number;
  close: () => Promise<void>;
};

function buildRealBuffer(options: RedisOptions): BufferHarness {
  const real = new MollifierBuffer({ redisOptions: options });
  let claimCalls = 0;
  let pendingCount = 0;
  let resolveSecondPending!: () => void;
  const secondClaimPending = new Promise<void>((r) => (resolveSecondPending = r));
  let resolveBothLosersPending!: () => void;
  const bothLosersPending = new Promise<void>((r) => (resolveBothLosersPending = r));

  const buffer = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "claimIdempotency") {
        return async (
          input: Parameters<MollifierBuffer["claimIdempotency"]>[0]
        ): Promise<IdempotencyClaimResult> => {
          claimCalls += 1;
          const result = await target.claimIdempotency(input);
          // A real "pending" means the SETNX already had a winner and THIS caller is the loser: it
          // has probed PG (missed) and is now blocked on the winner. Open the barrier so the winner
          // can proceed to create + publish, guaranteeing both claimants contend first.
          if (result.kind === "pending") {
            pendingCount += 1;
            resolveSecondPending();
            if (pendingCount >= 2) resolveBothLosersPending();
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as MollifierBuffer;

  return {
    buffer,
    secondClaimPending,
    bothLosersPending,
    get claimCalls() {
      return claimCalls;
    },
    close: () => real.close(),
  };
}

// heteroPostgresTest gives us the two physical Postgres DBs (PG14 legacy + PG17 new). Compose a
// per-test Redis container alongside (the isolatedRedisTest / postgresAndRedisTest precedent:
// network + redisContainer + redisOptions), then hand each test a real MollifierBuffer over it. The
// harness is a fixture so its Redis client is closed on teardown WHILE the container is still up
// (fixtures tear down in reverse: harness before redisContainer), never leaking a client.
const heteroPgWithRedisTest = heteroPostgresTest.extend<{
  network: StartedNetwork;
  redisContainer: StartedRedisContainer;
  redisOptions: RedisOptions;
  bufferHarness: BufferHarness;
}>({
  network,
  redisContainer,
  redisOptions,
  bufferHarness: async ({ redisOptions }, use) => {
    const harness = buildRealBuffer(redisOptions);
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },
});

// --- Real split RoutingRunStore over the two containers ----------------------------------------
function makeSplitRouter(prisma14: PrismaClient, prisma17: PrismaClient) {
  const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
  const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

type SharedEnv = {
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
};

// Seed the SAME logical env (identical scalar ids) on BOTH physical DBs so a child's FK-bearing
// create resolves whichever DB its id-shape routes it to.
async function seedSharedEnv(
  prisma14: PrismaClient,
  prisma17: PrismaClient,
  suffix: string
): Promise<SharedEnv> {
  const organizationId = `org_${suffix}`;
  const projectId = `proj_${suffix}`;
  const runtimeEnvironmentId = `env_${suffix}`;
  for (const prisma of [prisma14, prisma17]) {
    await prisma.organization.create({
      data: { id: organizationId, title: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        name: `Project ${suffix}`,
        slug: `project-${suffix}`,
        externalRef: `proj_${suffix}`,
        organizationId,
      },
    });
    await prisma.runtimeEnvironment.create({
      data: {
        id: runtimeEnvironmentId,
        type: "DEVELOPMENT",
        slug: "dev",
        projectId,
        organizationId,
        apiKey: `tr_dev_${suffix}`,
        pkApiKey: `pk_dev_${suffix}`,
        shortcode: `short_${suffix}`,
      },
    });
  }
  return { organizationId, projectId, runtimeEnvironmentId };
}

function makeCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  env: SharedEnv;
  idempotencyKey: string;
  taskIdentifier: string;
  // Winner-seed overrides: an EXPIRED-key winner (expiry in the past) or a
  // FAILED-status winner, so the resolved-winner clear-and-recreate branch of
  // handleExistingRun fires. Default is a live PENDING run with a 24h key.
  status?: TaskRunStatus;
  idempotencyKeyExpiresAt?: Date;
}) {
  return {
    data: {
      id: params.runId,
      engine: "V2" as const,
      status: params.status ?? ("PENDING" as const),
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.env.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT" as const,
      organizationId: params.env.organizationId,
      projectId: params.env.projectId,
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt:
        params.idempotencyKeyExpiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      taskIdentifier: params.taskIdentifier,
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      queue: "task/my-task",
      isTest: false,
      depth: 1,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2" as const,
      executionStatus: "RUN_CREATED" as const,
      description: "Run was created",
      runStatus: "PENDING" as const,
      environmentId: params.env.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT" as const,
      projectId: params.env.projectId,
      organizationId: params.env.organizationId,
    },
  };
}

type Residency = "NEW" | "LEGACY";

// A NEW-resident id (run-ops id) → routes to #new; a LEGACY-resident id (cuid) → routes to #legacy.
function mintChildId(residency: Residency): string {
  return residency === "NEW" ? generateRunOpsId() : RunId.generate().id;
}
function mintParentFriendlyId(residency: Residency): string {
  return `run_${residency === "NEW" ? generateRunOpsId() : RunId.generate().id}`;
}

type TriggerSpec = {
  parentResidency: Residency;
  idempotencyKey: string;
  scope?: "run" | "attempt" | "global";
  taskIdentifier: string;
  // andWait: block this parent on the resolved run's waitpoint.
  resumeParentOnCompletion?: boolean;
  // Explicit parent friendlyId (a seeded parent) — overrides the random mint. Required for the
  // andWait path so the parent-in-caller-env validation can find a real row.
  parentRunFriendlyId?: string;
};

function makeRequest(env: SharedEnv, spec: TriggerSpec): TriggerTaskRequest {
  return {
    taskId: spec.taskIdentifier,
    environment: {
      id: env.runtimeEnvironmentId,
      organizationId: env.organizationId,
      projectId: env.projectId,
      // No mollifierEnabled override → the per-org mollifier flag resolves false, so the ONLY thing
      // that can make the claim eligible is the global-under-split rule.
      organization: { featureFlags: {} },
    },
    options: {},
    body: {
      options: {
        idempotencyKey: spec.idempotencyKey,
        parentRunId: spec.parentRunFriendlyId ?? mintParentFriendlyId(spec.parentResidency),
        ...(spec.resumeParentOnCompletion ? { resumeParentOnCompletion: true } : {}),
        ...(spec.scope ? { idempotencyKeyOptions: { key: "user-key", scope: spec.scope } } : {}),
      },
    },
  } as unknown as TriggerTaskRequest;
}

async function countChildren(
  prisma14: PrismaClient,
  prisma17: PrismaClient,
  env: SharedEnv,
  idempotencyKey: string,
  taskIdentifier: string
) {
  const where = {
    runtimeEnvironmentId: env.runtimeEnvironmentId,
    idempotencyKey,
    taskIdentifier,
  };
  const legacy = await prisma14.taskRun.count({ where });
  const nw = await prisma17.taskRun.count({ where });
  return { legacy, new: nw, total: legacy + nw };
}

// Drive two triggers whose dedup PROBES are both forced to run before either child is created.
// `A` is the first (winning) trigger; `B` is the second (losing) trigger. Returns each outcome.
async function driveConcurrentPair(opts: {
  concern: IdempotencyKeyConcern;
  router: RoutingRunStore;
  buffer: { secondClaimPending: Promise<void> };
  env: SharedEnv;
  a: { spec: TriggerSpec; childResidency: Residency };
  b: { spec: TriggerSpec; childResidency: Residency };
}) {
  const { concern, router, env } = opts;

  const childA = mintChildId(opts.a.childResidency);
  const childAFriendly = `run_${childA}`;
  const childB = mintChildId(opts.b.childResidency);
  const childBFriendly = `run_${childB}`;

  const reqA = makeRequest(env, opts.a.spec);
  const reqB = makeRequest(env, opts.b.spec);

  // Phase 1: A probes + (maybe) claims. Runs to completion but creates NOTHING — the create is the
  // caller's job, played below. A is the first claimant, so it wins the SETNX and returns immediately.
  const aRes = await concern.handleTriggerRequest(reqA, undefined);

  let resolveBReturned!: () => void;
  const bReturned = new Promise<void>((r) => (resolveBReturned = r));

  const createChild = (childId: string, friendlyId: string, spec: TriggerSpec) =>
    router.createRun(
      makeCreateRunInput({
        runId: childId,
        friendlyId,
        env,
        idempotencyKey: spec.idempotencyKey,
        taskIdentifier: spec.taskIdentifier,
      }) as never
    );

  // B: probe + (maybe) claim-wait. This blocks on the claim until A publishes.
  const bFlow = (async () => {
    const res = await concern.handleTriggerRequest(reqB, undefined);
    resolveBReturned();
    if (!res.isCached) {
      await createChild(childB, childBFriendly, opts.b.spec);
      if (res.claim) {
        await publishClaim({ ...res.claim, runId: childBFriendly });
      }
    }
    return res;
  })();

  // A: create + publish, but hold the create open until B has entered the claim wait (via the real
  // "pending" barrier) or fully returned without a claim (the negative control) — so B's probe
  // always precedes A's create.
  const aFlow = (async () => {
    if (!aRes.isCached) {
      await Promise.race([opts.buffer.secondClaimPending, bReturned]);
      await createChild(childA, childAFriendly, opts.a.spec);
      if (aRes.claim) {
        await publishClaim({ ...aRes.claim, runId: childAFriendly });
      }
    }
  })();

  const [, bRes] = await Promise.all([aFlow, bFlow]);
  return { aRes, bRes, childAFriendly, childBFriendly };
}

// Drive ONE winner + TWO losers against a single global key. The winner (A) wins the claim and
// creates an EXPIRED- or FAILED-status child, then publishes it — but HOLDS the create until BOTH
// losers (B, C) have probed PG (missed) and are blocked on the claim (`bothLosersPending`). Both
// losers then resolve to the winner's cleared child. A single loser recreating a cleared winner is
// correct; the DUPLICATE only appears when TWO losers clear the same winner and each recreates on a
// different DB (no cross-DB unique backstop) — hence a trio, not a pair. The winner-seed overrides
// (status / idempotencyKeyExpiresAt) pick which clear branch of handleExistingRun fires.
async function driveWinnerPlusTwoLosers(opts: {
  concern: IdempotencyKeyConcern;
  router: RoutingRunStore;
  buffer: { bothLosersPending: Promise<void> };
  env: SharedEnv;
  idempotencyKey: string;
  taskIdentifier: string;
  winnerSeed: { status?: TaskRunStatus; idempotencyKeyExpiresAt?: Date };
  a: { spec: TriggerSpec; childResidency: Residency };
  b: { spec: TriggerSpec; childResidency: Residency };
  c: { spec: TriggerSpec; childResidency: Residency };
}) {
  const { concern, router, env } = opts;

  const childW = mintChildId(opts.a.childResidency);
  const childWFriendly = `run_${childW}`;
  const childB = mintChildId(opts.b.childResidency);
  const childBFriendly = `run_${childB}`;
  const childC = mintChildId(opts.c.childResidency);
  const childCFriendly = `run_${childC}`;

  const reqA = makeRequest(env, opts.a.spec);
  const reqB = makeRequest(env, opts.b.spec);
  const reqC = makeRequest(env, opts.c.spec);

  const createChild = (
    childId: string,
    friendlyId: string,
    spec: TriggerSpec,
    seed?: { status?: TaskRunStatus; idempotencyKeyExpiresAt?: Date }
  ) =>
    router.createRun(
      makeCreateRunInput({
        runId: childId,
        friendlyId,
        env,
        idempotencyKey: spec.idempotencyKey,
        taskIdentifier: spec.taskIdentifier,
        ...seed,
      }) as never
    );

  // Phase 1: A probes + wins the claim (no create yet — that's the caller's job below).
  const aRes = await concern.handleTriggerRequest(reqA, undefined);

  // Loser flow: probe + claim-wait; on a NON-cached return, create its child and (if it holds a
  // reacquired claim) publish it. Exactly one loser reacquires the claim and creates; the other
  // resolves to that fresh run as a cached hit and creates nothing.
  const loserFlow = (
    req: TriggerTaskRequest,
    childId: string,
    friendlyId: string,
    spec: TriggerSpec
  ) =>
    (async () => {
      const res = await concern.handleTriggerRequest(req, undefined);
      if (!res.isCached) {
        await createChild(childId, friendlyId, spec);
        if (res.claim) {
          await publishClaim({ ...res.claim, runId: friendlyId });
        }
      }
      return res;
    })();

  const bFlow = loserFlow(reqB, childB, childBFriendly, opts.b.spec);
  const cFlow = loserFlow(reqC, childC, childCFriendly, opts.c.spec);

  // A: hold the winner create+publish until BOTH losers are blocked on the claim, so both probe
  // BEFORE the winner child exists and both take the claim-loser path on the SAME resolved winner.
  const aFlow = (async () => {
    if (!aRes.isCached) {
      await opts.buffer.bothLosersPending;
      await createChild(childW, childWFriendly, opts.a.spec, opts.winnerSeed);
      if (aRes.claim) {
        await publishClaim({ ...aRes.claim, runId: childWFriendly });
      }
    }
  })();

  const [, bRes, cRes] = await Promise.all([aFlow, bFlow, cFlow]);
  return { aRes, bRes, cRes, childWFriendly, childBFriendly, childCFriendly };
}

describe("run-ops split — CONCURRENT global-scope idempotency dedup across two different-residency parents", () => {
  heteroPgWithRedisTest(
    "global scope, NEW-parent winner + LEGACY-parent loser: exactly one child, loser resolves to winner",
    async ({ prisma14, prisma17, bufferHarness }) => {
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_a");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "global-key-concurrent-a";
      const taskIdentifier = "child-task";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { bRes, childAFriendly } = await driveConcurrentPair({
        concern,
        router,
        buffer: bufferHarness,
        env,
        a: {
          spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
          childResidency: "NEW",
        },
        b: {
          spec: { parentResidency: "LEGACY", idempotencyKey, scope: "global", taskIdentifier },
          childResidency: "LEGACY",
        },
      });

      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);

      // Load-bearing assertion: one global key ⇒ exactly ONE child, across two physical DBs.
      expect(counts.total).toBe(1);
      // The loser must be a cached hit resolving to the winner's run.
      expect(bRes.isCached).toBe(true);
      if (bRes.isCached === true) {
        expect(bRes.run.friendlyId).toBe(childAFriendly);
      }
      // The claim was actually contended (both triggers hit the real SETNX) — proves the mutex was
      // exercised for real.
      expect(bufferHarness.claimCalls).toBeGreaterThanOrEqual(2);
    }
  );

  heteroPgWithRedisTest(
    "global scope, LEGACY-parent winner + NEW-parent loser: exactly one child (symmetric)",
    async ({ prisma14, prisma17, bufferHarness }) => {
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_b");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "global-key-concurrent-b";
      const taskIdentifier = "child-task";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { bRes, childAFriendly } = await driveConcurrentPair({
        concern,
        router,
        buffer: bufferHarness,
        env,
        a: {
          spec: { parentResidency: "LEGACY", idempotencyKey, scope: "global", taskIdentifier },
          childResidency: "LEGACY",
        },
        b: {
          spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
          childResidency: "NEW",
        },
      });

      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);
      expect(counts.total).toBe(1);
      expect(bRes.isCached).toBe(true);
      if (bRes.isCached === true) {
        expect(bRes.run.friendlyId).toBe(childAFriendly);
      }
    }
  );

  heteroPgWithRedisTest(
    "global scope andWait loser: exactly one child AND the loser's parent (other DB) is blocked on the WINNER's run waitpoint",
    async ({ prisma14, prisma17, bufferHarness }) => {
      // The by-id cross-DB resolution (resolveWinnerAcrossDbs) the plain cases don't fully assert:
      // the LOSER is an andWait trigger whose parent lives on the LEGACY DB, while the WINNER's child
      // lives on the NEW DB. When the loser resolves the claim it must (1) dedup to the single winner
      // child (across DBs), and (2) wire ITS parent's waitpoint against the WINNER's run — i.e. find
      // the winner on the other DB, get/create the winner's run waitpoint, and block the loser's
      // parent on that waitpoint. A real engine can't span two physical DBs, so we stub the two
      // waitpoint methods to record their args; the resolution + routing that feeds them is real.
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_andwait");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "global-key-concurrent-andwait";
      const taskIdentifier = "child-task";
      const parentTaskIdentifier = "parent-task";

      // The loser's parent lives on the LEGACY (PG14) DB. Its friendlyId is a cuid-shaped run id so
      // RunId.fromFriendlyId → routes the parent-in-caller-env validation to the legacy store.
      const loserParent = RunId.generate();
      await prisma14.taskRun.create({
        data: {
          id: loserParent.id,
          friendlyId: loserParent.friendlyId,
          engine: "V2",
          status: "EXECUTING",
          runtimeEnvironmentId: env.runtimeEnvironmentId,
          environmentType: "DEVELOPMENT",
          organizationId: env.organizationId,
          projectId: env.projectId,
          taskIdentifier: parentTaskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          traceId: `trace_${loserParent.id}`,
          spanId: `span_${loserParent.id}`,
          queue: "task/parent-task",
          isTest: false,
          depth: 0,
        },
      });

      // Stub engine: record the winner waitpoint get/create + the parent block.
      const getOrCreateCalls: Array<{ runId: string; projectId: string; environmentId: string }> =
        [];
      const blockCalls: Array<{ runId: string; waitpoints: string | string[] }> = [];
      const winnerWaitpoint = {
        id: "waitpoint_winner_run",
        status: "PENDING" as const,
        outputIsError: false,
      };
      const stubEngine = {
        async getOrCreateRunWaitpoint(input: {
          runId: string;
          projectId: string;
          environmentId: string;
        }) {
          getOrCreateCalls.push(input);
          return winnerWaitpoint;
        },
        async blockRunWithWaitpoint(input: { runId: string; waitpoints: string | string[] }) {
          blockCalls.push({ runId: input.runId, waitpoints: input.waitpoints });
          return {};
        },
      };

      // Stub traceEventConcern: just run the callback with a minimal span (the andWait path reads
      // event.spanId / event.traceparent).
      const stubTrace: Partial<TraceEventConcern> = {
        async traceIdempotentRun(_request, _parentStore, _options, callback) {
          return callback(
            {
              spanId: "span_trace",
              traceparent: undefined,
              traceId: "trace_x",
              traceContext: {},
              setAttribute: () => {},
              failWithError: () => {},
              stop: () => {},
            } as never,
            "test"
          );
        },
      };

      const concern = new IdempotencyKeyConcern(
        prisma14 as never,
        stubEngine as never,
        stubTrace as never
      );

      const { bRes, childAFriendly } = await driveConcurrentPair({
        concern,
        router,
        buffer: bufferHarness,
        env,
        a: {
          // Winner: NEW parent, plain global trigger, NEW-resident child (lands on the NEW DB).
          spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
          childResidency: "NEW",
        },
        b: {
          // Loser: andWait, LEGACY parent (seeded above, on the OTHER DB), same global key.
          spec: {
            parentResidency: "LEGACY",
            idempotencyKey,
            scope: "global",
            taskIdentifier,
            resumeParentOnCompletion: true,
            parentRunFriendlyId: loserParent.friendlyId,
          },
          childResidency: "LEGACY",
        },
      });

      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);
      const winnerInternalId = RunId.fromFriendlyId(childAFriendly);

      // (1) Dedup held across DBs: exactly ONE child, and the loser is a cached hit to the winner.
      expect(counts.total).toBe(1);
      expect(counts.new).toBe(1); // the winner child lives on the NEW DB
      expect(counts.legacy).toBe(0); // the loser NEVER created a legacy-DB child
      expect(bRes.isCached).toBe(true);
      if (bRes.isCached === true) {
        expect(bRes.run.friendlyId).toBe(childAFriendly);
      }

      // (2) Cross-DB waitpoint linkage: resolveWinnerAcrossDbs found the winner on the NEW DB, and
      // the loser got/created the waitpoint against the WINNER's run id (not its own parent's).
      expect(getOrCreateCalls).toHaveLength(1);
      expect(getOrCreateCalls[0]!.runId).toBe(winnerInternalId);
      expect(getOrCreateCalls[0]!.environmentId).toBe(env.runtimeEnvironmentId);

      // (3) …and the loser's parent (which lives on the LEGACY DB) is blocked on the WINNER's run
      // waitpoint — the by-id cross-DB resolution wired one DB's parent to the other DB's run.
      expect(blockCalls).toHaveLength(1);
      expect(blockCalls[0]!.runId).toBe(loserParent.id);
      expect(blockCalls[0]!.waitpoints).toBe(winnerWaitpoint.id);

      // The claim was contended for real (both triggers hit the SETNX).
      expect(bufferHarness.claimCalls).toBeGreaterThanOrEqual(2);
    }
  );

  heteroPgWithRedisTest(
    "options-absent under split (pre-hashed key / older SDK): treated conservatively → one child",
    async ({ prisma14, prisma17, bufferHarness }) => {
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_c");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "prehashed-key-concurrent-c";
      const taskIdentifier = "child-task";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { bRes } = await driveConcurrentPair({
        concern,
        router,
        buffer: bufferHarness,
        env,
        a: {
          // No `scope` → no idempotencyKeyOptions on the wire (pre-hashed key / older SDK).
          spec: { parentResidency: "NEW", idempotencyKey, taskIdentifier },
          childResidency: "NEW",
        },
        b: {
          spec: { parentResidency: "LEGACY", idempotencyKey, taskIdentifier },
          childResidency: "LEGACY",
        },
      });

      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);
      expect(counts.total).toBe(1);
      expect(bRes.isCached).toBe(true);
    }
  );

  heteroPgWithRedisTest(
    "global scope, EXPIRED-key winner cleared by TWO concurrent losers: exactly one NEW child (reacquired)",
    async ({ prisma14, prisma17, bufferHarness }) => {
      // The critical residual this covers: the resolved winner's key is EXPIRED, so each loser's
      // handleExistingRun clears it and would recreate a NEW run. Two losers on different-residency
      // parents recreate on different DBs where the per-DB unique index can't dedup them, so the
      // recreate must re-serialise through the claim — one loser reacquires + creates, the other
      // resolves to it → exactly ONE new child.
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_expired");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "global-key-expired-winner";
      const taskIdentifier = "child-task";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { bRes, cRes, childWFriendly, childBFriendly, childCFriendly } =
        await driveWinnerPlusTwoLosers({
          concern,
          router,
          buffer: bufferHarness,
          env,
          idempotencyKey,
          taskIdentifier,
          // Winner child is a genuinely-expired run: an EXPIRED status AND an already-expired key, so
          // handleExistingRun's expiry branch clears it. Both attributes matter for determinism: the
          // expiry drives the clear; the EXPIRED status keeps the SECOND loser on the clear path even
          // after the first loser's clear has NULLed the key + expiry (a plain PENDING winner would
          // then look "live" to the second reader and dedup by accident, masking the duplicate).
          winnerSeed: { status: "EXPIRED", idempotencyKeyExpiresAt: new Date(Date.now() - 60_000) },
          a: {
            spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "NEW",
          },
          b: {
            spec: { parentResidency: "LEGACY", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "LEGACY",
          },
          c: {
            spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "NEW",
          },
        });

      // The winner's key was cleared, so only the recreated child(ren) still carry the key. Exactly
      // ONE new child ⇒ the reacquire serialised the two losers' recreate across the split.
      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);
      expect(counts.total).toBe(1);
      // Exactly one loser recreated (claim reacquired); the other resolved to it as a cached hit.
      const cachedCount = [bRes, cRes].filter((r) => r.isCached).length;
      expect(cachedCount).toBe(1);
      // The cached loser must resolve to the RECREATED run (the other loser's fresh child), NOT the
      // cleared winner — a stale isCached still pointing at childWFriendly would otherwise slip past.
      const recreaterFriendly = bRes.isCached ? childCFriendly : childBFriendly;
      const cachedLoser = bRes.isCached ? bRes : cRes;
      if (cachedLoser.isCached === true) {
        expect(cachedLoser.run.friendlyId).toBe(recreaterFriendly);
        expect(cachedLoser.run.friendlyId).not.toBe(childWFriendly);
      }
      // Both losers genuinely contended on the claim (winner + two losers ⇒ ≥3 attempts).
      expect(bufferHarness.claimCalls).toBeGreaterThanOrEqual(3);
    }
  );

  heteroPgWithRedisTest(
    "global scope, FAILED-status winner cleared by TWO concurrent losers: exactly one NEW child (reacquired)",
    async ({ prisma14, prisma17, bufferHarness }) => {
      // Same critical residual via the OTHER clear branch: the resolved winner is in a failed status
      // (shouldIdempotencyKeyBeCleared === true), so handleExistingRun clears its key and each loser
      // would recreate → the recreate re-serialises through the claim to yield exactly one child.
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_failed");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const idempotencyKey = "global-key-failed-winner";
      const taskIdentifier = "child-task";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { bRes, cRes, childWFriendly, childBFriendly, childCFriendly } =
        await driveWinnerPlusTwoLosers({
          concern,
          router,
          buffer: bufferHarness,
          env,
          idempotencyKey,
          taskIdentifier,
          // Winner child carries a LIVE (future) key but a failed status → status-clear branch fires.
          winnerSeed: { status: "COMPLETED_WITH_ERRORS" },
          a: {
            spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "NEW",
          },
          b: {
            spec: { parentResidency: "LEGACY", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "LEGACY",
          },
          c: {
            spec: { parentResidency: "NEW", idempotencyKey, scope: "global", taskIdentifier },
            childResidency: "NEW",
          },
        });

      const counts = await countChildren(prisma14, prisma17, env, idempotencyKey, taskIdentifier);
      expect(counts.total).toBe(1);
      const cachedCount = [bRes, cRes].filter((r) => r.isCached).length;
      expect(cachedCount).toBe(1);
      // The cached loser must resolve to the RECREATED run (the other loser's fresh child), NOT the
      // cleared winner — a stale isCached still pointing at childWFriendly would otherwise slip past.
      const recreaterFriendly = bRes.isCached ? childCFriendly : childBFriendly;
      const cachedLoser = bRes.isCached ? bRes : cRes;
      if (cachedLoser.isCached === true) {
        expect(cachedLoser.run.friendlyId).toBe(recreaterFriendly);
        expect(cachedLoser.run.friendlyId).not.toBe(childWFriendly);
      }
      expect(bufferHarness.claimCalls).toBeGreaterThanOrEqual(3);
    }
  );

  heteroPgWithRedisTest(
    "NEGATIVE CONTROL — run scope, distinct per-parent keys: TWO children, no claim contention",
    async ({ prisma14, prisma17, bufferHarness }) => {
      const env = await seedSharedEnv(prisma14, prisma17, "gcc_d");
      const router = makeSplitRouter(prisma14, prisma17);
      h.router = router;
      h.buffer = bufferHarness.buffer;
      h.splitOn = true;

      const taskIdentifier = "child-task";
      // Run-scope keys embed the parent run id in their hash, so two parents produce DIFFERENT
      // hashed keys. These are genuinely distinct runs and must NOT be deduped.
      const keyA = "run-scope-hash-A";
      const keyB = "run-scope-hash-B";
      const concern = new IdempotencyKeyConcern(prisma14 as never, {} as never, {} as never);

      const { aRes, bRes } = await driveConcurrentPair({
        concern,
        router,
        buffer: bufferHarness,
        env,
        a: {
          spec: { parentResidency: "NEW", idempotencyKey: keyA, scope: "run", taskIdentifier },
          childResidency: "NEW",
        },
        b: {
          spec: { parentResidency: "LEGACY", idempotencyKey: keyB, scope: "run", taskIdentifier },
          childResidency: "LEGACY",
        },
      });

      const a = await countChildren(prisma14, prisma17, env, keyA, taskIdentifier);
      const b = await countChildren(prisma14, prisma17, env, keyB, taskIdentifier);

      // Two distinct keys ⇒ two distinct children, one per DB. Neither is a cached hit.
      expect(a.total).toBe(1);
      expect(b.total).toBe(1);
      expect(aRes.isCached).toBe(false);
      expect(bRes.isCached).toBe(false);
      // Run-scope under split is NOT global-under-split and the org isn't mollifier-enabled, so the
      // claim mutex is never touched — the negative control never contends on the claim.
      expect(bufferHarness.claimCalls).toBe(0);
    }
  );
});
