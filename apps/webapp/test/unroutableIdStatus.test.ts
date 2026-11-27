// `resolveShard` is pure id-shape, so any base32hex core plus `[a-z0-9]` plus "2" parses as gen-2
// and names a shard — including one a caller invents. The routing store throws for a key it has no
// store for, which is correct and deliberately loud, but a read route that lets it reach the
// boundary answered 500 for caller-supplied input. These tests pin the boundary status.
import { describe, expect, it, vi } from "vitest";
import { json } from "@remix-run/server-runtime";
import {
  MEMORYDB_SHARD_KEY,
  organizationContext,
  PostgresRunStore,
  RoutingRunStore,
  UnknownShardKey,
} from "@internal/run-store";
import type * as RootResidencyModule from "~/v3/runOpsMigration/resolveRootResidency.server";
import type * as ResolveRunMintTargetModule from "~/v3/runOpsMigration/resolveRunMintTarget.server";
import type * as MintBatchFriendlyIdModule from "~/v3/runOpsMigration/mintBatchFriendlyId.server";
import { unroutableIdResponse } from "~/services/routeBuilders/unroutableId.server";

describe("unroutableIdResponse", () => {
  it("answers 404 for an id naming a shard with no configured store", async () => {
    const response = unroutableIdResponse(new UnknownShardKey("z", ["legacy", "new"]));

    expect(response).toBeDefined();
    expect(response!.status).toBe(404);
    // Not retryable: no number of retries makes a topology grow a store. Contrast the
    // waitpoint wait route, whose 404 IS retryable because a miss there can be replica lag.
    expect(response!.headers.get("x-should-retry")).toBe("false");
    await expect(response!.json()).resolves.toEqual({ error: "Not Found" });
  });

  it("declines an unrelated error so it still reaches the 500 path", () => {
    expect(unroutableIdResponse(new Error("db down"))).toBeUndefined();
    expect(unroutableIdResponse(undefined)).toBeUndefined();
    expect(unroutableIdResponse("a string")).toBeUndefined();
  });

  it("declines a deliberately thrown Response, which carries its own status", () => {
    expect(unroutableIdResponse(json({ error: "nope" }, { status: 422 }))).toBeUndefined();
  });

  it("keeps the key and the configured set on the error for the operator", () => {
    // A 404 to the caller must not cost the operator what separates a forged id from a shard
    // key dropped out of a config that is meant to be append-only.
    const error = new UnknownShardKey("z", ["legacy", "new", "a"]);

    expect(error.shardKey).toBe("z");
    expect(error.configured).toContain("a");
  });
});

// The mint master switch off for this suite, whatever the runner sets; env.server reads it at import.
vi.hoisted(() => {
  process.env.RUN_OPS_MINT_ENABLED = "0";
});

// ---- The routes, driven end to end: real route actions over a real routing store on two
// databases and a real run engine. Shard `a` is configured (an alias of the run-ops store);
// `m` and `z` are not. Only auth, request idempotency, trace events, entitlement, the batch
// limiter and modules that connect at import are replaced.
const holder = vi.hoisted(() => ({
  store: undefined as any,
  engine: undefined as any,
  prisma14: undefined as any,
  prisma17: undefined as any,
  environment: undefined as any,
  // false: the credential has no type-level `write:runs` grant.
  canWriteRuns: true,
  batchStreamGrants: undefined as any,
  mollifierBuffer: null as any,
  enqueue: undefined as any,
  // The method names the stand-in under `m` was called with, in order.
  standInCalls: [] as string[],
  // Per stand-in call: whether the scope in force had been marked born here.
  standInContexts: [] as { method: string; bornHere: boolean }[],
  // The root residency decision's process inputs; an Error makes its reader throw.
  residencyEnv: undefined as any,
  split: true,
  globalFlags: undefined as any,
  unsupportedGroups: [] as any,
  memoryDbRegistered: false,
  ruleCalls: 0,
  waitpointStore: undefined as any,
}));

vi.mock("~/db.server", async () => {
  const { Prisma, boundedIn } = await import("@trigger.dev/database");
  const forward = (key: "prisma14" | "prisma17") =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          const client = holder[key];
          if (!client) throw new Error(`test bug: holder.${key} not set`);
          const value = client[prop];
          return typeof value === "function" ? value.bind(client) : value;
        },
      }
    );
  const legacy = forward("prisma14");
  const runOps = forward("prisma17");
  return {
    prisma: legacy,
    $replica: legacy,
    runOpsLegacyPrisma: legacy,
    runOpsLegacyReplica: legacy,
    runOpsLegacyPrismaClient: legacy,
    runOpsLegacyReplicaClient: legacy,
    runOpsNewPrisma: runOps,
    runOpsNewReplica: runOps,
    runOpsNewPrismaClient: runOps,
    runOpsNewReplicaClient: runOps,
    runOpsShardHandles: [],
    runOpsSplitReadEnabled: true,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    DATABASE_SCHEMA: "public",
    Prisma,
    boundedIn,
  };
});

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: holder.environment,
      subject: { type: "private" },
      ability: {
        can: (_action: string, resource: { type?: string }) =>
          holder.canWriteRuns || resource?.type !== "runs",
        canSuper: () => true,
      },
      jwt: undefined,
    }),
  },
}));

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const value = holder.store[prop];
        return typeof value === "function" ? value.bind(holder.store) : value;
      },
    }
  ),
  // The harness's store is always the routing store.
  runStoreRoutesByShard: true,
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy(
    {},
    {
      get(_t, prop) {
        const value = holder.engine[prop];
        return typeof value === "function" ? value.bind(holder.engine) : value;
      },
    }
  ),
}));

// The decision with the residency switch's real rule; only the process inputs are the test's.
vi.mock("~/v3/runOpsMigration/resolveRootResidency.server", async (importOriginal) => {
  const actual = await importOriginal<typeof RootResidencyModule>();
  const { createRunResidencyAllowedResolver } = await import("~/v3/utils/runResidency.server");
  const read = (key: "globalFlags" | "unsupportedGroups") => {
    const value = holder[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    ...actual,
    rootResidency: actual.createRootResidencyDecision({
      isResidencyAllowed: (organizationFlags) => {
        holder.ruleCalls++;
        return createRunResidencyAllowedResolver({
          env: holder.residencyEnv,
          isSplitEnabled: async () => holder.split,
          readGlobalFlags: () => read("globalFlags"),
          graceMs: 90_000,
        })(organizationFlags);
      },
      readGlobalFlags: () => read("globalFlags"),
      readUnsupportedGroups: () => read("unsupportedGroups"),
      memoryDbStoreRegistered: () => holder.memoryDbRegistered,
    }),
  };
});

vi.mock("~/v3/runOpsMigration/resolveRunMintTarget.server", async (importOriginal) => {
  const actual = await importOriginal<typeof ResolveRunMintTargetModule>();
  return { ...actual, resolveRunMintTarget: vi.fn(actual.resolveRunMintTarget) };
});

vi.mock("~/v3/runOpsMigration/mintBatchFriendlyId.server", async (importOriginal) => {
  const actual = await importOriginal<typeof MintBatchFriendlyIdModule>();
  return { ...actual, mintBatchFriendlyId: vi.fn(actual.mintBatchFriendlyId) };
});

vi.mock("~/v3/runOpsMigration/splitMode.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isSplitEnabled: async () => true,
}));

vi.mock("~/services/requestIdempotencyInstance.server", () => ({
  requestIdempotency: { checkRequest: async () => null, saveRequest: async () => {} },
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEntitlement: vi.fn(),
}));

vi.mock("~/runEngine/concerns/traceEvents.server", async () => {
  const { MockTraceEventConcern } = await import("./engine/triggerTaskTestHelpers");
  return { DefaultTraceEventsConcern: MockTraceEventConcern };
});

vi.mock("~/v3/batchTriggerWorker.server", () => ({
  batchTriggerWorker: { enqueue: (...args: unknown[]) => holder.enqueue(...args) },
}));

vi.mock("~/runEngine/concerns/batchStreamGrantsInstance.server", () => ({
  batchStreamGrants: new Proxy(
    {},
    {
      get(_t, prop) {
        const value = holder.batchStreamGrants[prop];
        return typeof value === "function" ? value.bind(holder.batchStreamGrants) : value;
      },
    }
  ),
}));

vi.mock("~/runEngine/concerns/batchLimits.server", () => ({
  getBatchLimits: async () => ({
    config: { processingConcurrency: 1 },
    rateLimiter: {
      limit: async () => ({ success: true, limit: 1000, remaining: 1000, reset: Date.now() }),
    },
  }),
  BatchRateLimitExceededError: class BatchRateLimitExceededError extends Error {},
}));

vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => holder.mollifierBuffer,
}));

import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { heteroRunOpsWithRedisTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { Prisma } from "@trigger.dev/database";
import {
  AttemptId,
  BatchId,
  RunId,
  generateRunOpsId,
  generateRunOpsIdV2,
} from "@trigger.dev/core/v3/isomorphic";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { RunEngineBatchTriggerService } from "~/runEngine/services/batchTrigger.server";
import { logger } from "~/services/logger.server";
import { mintBatchFriendlyId } from "~/v3/runOpsMigration/mintBatchFriendlyId.server";
import { resolveRunMintTarget } from "~/v3/runOpsMigration/resolveRunMintTarget.server";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { BatchStreamGrants } from "~/runEngine/concerns/batchStreamGrants.server";
import { TriggerFailedTaskService } from "~/runEngine/services/triggerFailedTask.server";
import { setupBatchQueueCallbacks } from "~/v3/runEngineHandlers.server";
import { loader as runLoader } from "~/routes/api.v3.runs.$runId";
import { action as triggerAction } from "~/routes/api.v1.tasks.$taskId.trigger";
import { action as v1BatchAction } from "~/routes/api.v1.tasks.batch";
import { action as v1TaskBatchAction } from "~/routes/api.v1.tasks.$taskId.batch";
import { action as v2BatchAction } from "~/routes/api.v2.tasks.batch";
import { action as v3CreateBatchAction } from "~/routes/api.v3.batches";
import { action as v3ItemsAction } from "~/routes/api.v3.batches.$batchId.items";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TASK = "unroutable-task";
const MODELS = ["taskRun", "batchTaskRun", "waitpoint", "taskRunWaitpoint"] as const;
type Counts = Record<string, number>;

type HarnessOptions = {
  // A counting stand-in under `m`: a run there is a row on the run-ops database.
  standIn?: boolean;
  // A waitpoint store on the fixture's Redis, which a waiting MemoryDB child or batch needs.
  waitpointStore?: boolean;
  // The organisation's `featureFlags`.
  flags?: Record<string, unknown>;
};

// A run store under `m` that records each method it is asked, and forwards it bound to its target.
function standInStore(prisma17: any) {
  const target = new PostgresRunStore({
    prisma: prisma17,
    readOnlyPrisma: prisma17,
    schemaVariant: "dedicated",
  });
  return new Proxy(target, {
    get(t, prop) {
      const value = (t as any)[prop];
      if (typeof value !== "function") return value;
      return (...callArgs: unknown[]) => {
        holder.standInCalls.push(String(prop));
        holder.standInContexts.push({
          method: String(prop),
          bornHere: organizationContext.get()?.bornHere === true,
        });
        return value.apply(t, callArgs);
      };
    },
  });
}

// Builds the store, the engine and the environment, and points every mock at them.
async function harness({ prisma14, prisma17, redisOptions }: any, options: HarnessOptions = {}) {
  holder.prisma14 = prisma14;
  holder.prisma17 = prisma17;
  const runOpsStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  holder.store = new RoutingRunStore({
    new: runOpsStore,
    legacy: new PostgresRunStore({
      prisma: prisma14,
      readOnlyPrisma: prisma14,
      schemaVariant: "legacy",
    }),
    shards: [
      { key: "a", store: runOpsStore, aliasOf: "new" },
      ...(options.standIn
        ? [{ key: MEMORYDB_SHARD_KEY, store: standInStore(prisma17), aliasOf: "new" as const }]
        : []),
    ],
  });
  holder.standInCalls = [];
  holder.standInContexts = [];
  holder.residencyEnv = {
    RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: "redis://snapshot-store.invalid",
    RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: "redis://waitpoint-store.invalid",
    REALTIME_BACKEND_NATIVE_ENABLED: "1",
    REALTIME_BACKEND_DEFAULT: "native",
    TRIGGER_MOLLIFIER_ENABLED: "0",
  };
  holder.split = true;
  holder.globalFlags = undefined;
  holder.unsupportedGroups = [];
  holder.memoryDbRegistered = options.standIn === true;
  holder.ruleCalls = 0;
  holder.waitpointStore = options.waitpointStore
    ? new WaitpointStoreCoordinator({ redisOptions })
    : undefined;
  holder.engine = new RunEngine({
    prisma: prisma14,
    store: holder.store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    ...(holder.waitpointStore
      ? {
          waitpointStoreEnabled: async () => true,
          waitpointRouting: {
            store: new StoreWaitpointCoordinator({ store: holder.waitpointStore }),
            mintPolicy: { resolveMintMode: () => "redis" as const, isCapabilityReady: () => true },
          },
          waitpointStore: holder.waitpointStore,
          waitpointFanoutStore: holder.waitpointStore,
        }
      : {}),
  });
  setupBatchQueueCallbacks();
  holder.batchStreamGrants = new BatchStreamGrants({
    redis: { ...redisOptions, tlsDisabled: true, clusterMode: false },
    attempts: 10,
    ttlMs: 1_800_000,
  });
  holder.enqueue = vi.fn();
  holder.canWriteRuns = true;
  holder.mollifierBuffer = null;
  const seeded = await setupAuthenticatedEnvironment(prisma14, "PRODUCTION", "V2");
  if (options.flags) {
    await prisma14.organization.update({
      where: { id: seeded.organizationId },
      data: { featureFlags: options.flags },
    });
  }
  await setupBackgroundWorker(holder.engine, seeded, [TASK]);
  holder.environment = await findEnvironmentById(seeded.id);
  return holder.environment;
}

async function teardown() {
  await holder.batchStreamGrants?.redis?.quit();
  await holder.engine?.quit();
  holder.engine = undefined;
  await holder.waitpointStore?.quit();
  holder.waitpointStore = undefined;
}

async function counts(): Promise<Counts> {
  const out: Counts = {};
  for (const [db, client] of [
    ["legacy", holder.prisma14],
    ["runOps", holder.prisma17],
  ] as const) {
    for (const model of MODELS) out[`${db}.${model}`] = await client[model].count();
  }
  return out;
}

function delta(before: Counts, after: Counts): Counts {
  const out: Counts = {};
  for (const key of Object.keys(before)) {
    if (after[key] !== before[key]) out[key] = after[key]! - before[key]!;
  }
  return out;
}

async function answer(res: Response) {
  return {
    status: res.status,
    retry: res.headers.get("x-should-retry"),
    body: await res.json(),
  };
}

// cuid, gen1, or gen2:<shard key>, from an id's 26-character body.
function shape(friendlyId: string): string {
  const body = friendlyId.slice(friendlyId.indexOf("_") + 1);
  if (body.length !== 26) return "cuid";
  return body[25] === "1" ? "gen1" : `gen2:${body[24]}`;
}

function post(url: string, body: unknown) {
  const text = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      authorization: "Bearer api_key",
    },
    body: text,
  });
}

const args = (request: Request, params: Record<string, string> = {}) =>
  ({ request, params, context: {} }) as never;

// A generation 2 id on shard `key`; on `m` it is the shape a generation 3 id takes.
const runOn = (key: string) => RunId.toFriendlyId(generateRunOpsIdV2(key));

type Entry = (parent: string, wait: boolean) => Promise<Response>;

const ENTRIES: Record<string, Entry> = {
  "POST /api/v1/tasks/:taskId/trigger": (parent, wait) =>
    triggerAction(
      args(
        post(`http://localhost/api/v1/tasks/${TASK}/trigger`, {
          payload: {},
          options: { parentRunId: parent, ...(wait ? { resumeParentOnCompletion: true } : {}) },
        }),
        { taskId: TASK }
      )
    ),
  "POST /api/v1/tasks/batch": (parent, wait) =>
    v1BatchAction(
      args(
        post("http://localhost/api/v1/tasks/batch", {
          items: [
            { task: TASK, payload: {} },
            { task: TASK, payload: {} },
          ],
          parentRunId: parent,
          // This route waits on `dependentAttempt` and ignores `resumeParentOnCompletion`.
          ...(wait ? { dependentAttempt: AttemptId.generate().friendlyId } : {}),
        })
      )
    ),
  "POST /api/v1/tasks/:taskId/batch": (parent, wait) =>
    v1TaskBatchAction(
      args(
        post(`http://localhost/api/v1/tasks/${TASK}/batch`, {
          items: [0, 1].map(() => ({
            payload: {},
            options: { parentRunId: parent, ...(wait ? { resumeParentOnCompletion: true } : {}) },
          })),
        }),
        { taskId: TASK }
      )
    ),
  "POST /api/v2/tasks/batch": (parent, wait) =>
    v2BatchAction(
      args(
        post("http://localhost/api/v2/tasks/batch", {
          items: [
            { task: TASK, payload: {} },
            { task: TASK, payload: {} },
          ],
          parentRunId: parent,
          ...(wait ? { resumeParentOnCompletion: true } : {}),
        })
      )
    ),
  "POST /api/v3/batches": (parent, wait) =>
    v3CreateBatchAction(
      args(
        post("http://localhost/api/v3/batches", {
          runCount: 2,
          parentRunId: parent,
          ...(wait ? { resumeParentOnCompletion: true } : {}),
        })
      )
    ),
};

// Each request: its answer, with the shard key it echoes masked, and the row counts that changed.
async function drive(entry: Entry, parent: string, wait: boolean) {
  const before = await counts();
  const { body, ...rest } = await answer(await entry(parent, wait));
  const key = parent[parent.length - 2];
  const error = String(body.error).replace(`shard key "${key}"`, 'shard key "<key>"');
  return { ...rest, body: { ...body, error }, changed: delta(before, await counts()) };
}

const UNKNOWN_SHARD = 'RoutingRunStore: no store is configured for shard key "<key>"';
const PARENT_NOT_FOUND = "Parent run not found in the calling environment";

// Base's answer to a parent id on an unconfigured shard, waiting or not.
const UNCONFIGURED: Record<string, unknown> = {
  "POST /api/v1/tasks/:taskId/trigger": {
    status: 500,
    retry: null,
    body: { error: "Something went wrong" },
    changed: {},
  },
  "POST /api/v1/tasks/batch": {
    status: 500,
    retry: "false",
    body: { error: "Something went wrong" },
    changed: {},
  },
  // The route drops the parent, so its root batch is written before the items fail.
  "POST /api/v1/tasks/:taskId/batch": {
    status: 400,
    retry: null,
    body: { error: UNKNOWN_SHARD },
    changed: { "legacy.batchTaskRun": 1 },
  },
  "POST /api/v2/tasks/batch": {
    status: 500,
    retry: "false",
    body: { error: UNKNOWN_SHARD },
    changed: {},
  },
  "POST /api/v3/batches": {
    status: 500,
    retry: "false",
    body: { error: UNKNOWN_SHARD },
    changed: {},
  },
};

const routeTest = (name: string, body: () => Promise<void>, options?: HarnessOptions) =>
  heteroRunOpsWithRedisTest(name, async ({ prisma14, prisma17, redisOptions }) => {
    await harness({ prisma14, prisma17, redisOptions }, options);
    try {
      await body();
      expect(holder.enqueue).not.toHaveBeenCalled();
    } finally {
      await teardown();
    }
  });

async function runRow(friendlyId: string) {
  return (holder.prisma17 as any).taskRun.findFirst({
    where: { friendlyId },
    select: { parentTaskRunId: true, rootTaskRunId: true, depth: true },
  });
}

describe("route answers for a parent that names an unconfigured shard or no run", () => {
  // Catches: the route builder answering an unroutable run id with anything but a final 404.
  routeTest("route builder: a run id on m and on z answers 404", async () => {
    for (const key of ["m", "z"]) {
      const runId = runOn(key);
      const res = (await runLoader(
        args(
          new Request(`http://localhost/api/v3/runs/${runId}`, {
            headers: { authorization: "Bearer api_key" },
          }),
          { runId }
        )
      )) as Response;
      expect(await answer(res)).toEqual({
        status: 404,
        retry: "false",
        body: { error: "Not Found" },
      });
    }
  });

  for (const [name, entry] of Object.entries(ENTRIES)) {
    for (const wait of [false, true]) {
      // Catches: an entry point's answer to an unconfigured-shard parent drifting, or it writing.
      routeTest(
        `${name}${wait ? " (waiting)" : ""}: a parent on m and on z get the same answer`,
        async () => {
          const m = await drive(entry, runOn("m"), wait);
          const z = await drive(entry, runOn("z"), wait);
          expect(m).toEqual(z);
          expect(m).toEqual(UNCONFIGURED[name]);
        }
      );
    }
  }

  // Catches: the parent-write check of a credential without `write:runs` answering differently.
  routeTest(
    "single trigger without a write:runs grant: 404 for m, 403 for a missing parent",
    async () => {
      holder.canWriteRuns = false;
      const trigger = ENTRIES["POST /api/v1/tasks/:taskId/trigger"]!;
      expect(await drive(trigger, runOn("m"), false)).toEqual({
        status: 404,
        retry: "false",
        body: { error: "Not Found" },
        changed: {},
      });
      expect(await drive(trigger, RunId.toFriendlyId(generateRunOpsId()), false)).toEqual({
        status: 403,
        retry: null,
        body: { error: "Unauthorized" },
        changed: {},
      });
    }
  );

  // Catches: a missing parent on a configured store no longer giving a root of the id's shape.
  routeTest(
    "single trigger: a missing parent on a configured store gives a root of its shape",
    async () => {
      const trigger = ENTRIES["POST /api/v1/tasks/:taskId/trigger"]!;
      for (const [parent, expected] of [
        [RunId.toFriendlyId(generateRunOpsId()), "gen1"],
        [runOn("a"), "gen2:a"],
      ] as const) {
        const before = await counts();
        const { status, body } = await answer(await trigger(parent, false));
        expect(status).toBe(200);
        expect(shape(body.id)).toBe(expected);
        expect(await runRow(body.id)).toEqual(RECORDED_ROOT);
        expect(delta(before, await counts())).toEqual(RECORDED_ROOT_ROWS);
      }
    }
  );

  // Catches: the batch parent look-up changing for a parent that names no run, waiting or not.
  routeTest("batches: a run-ops parent id that names no run", async () => {
    const missing = () => RunId.toFriendlyId(generateRunOpsId());
    const v2 = ENTRIES["POST /api/v2/tasks/batch"]!;
    const v3 = ENTRIES["POST /api/v3/batches"]!;
    const v1 = ENTRIES["POST /api/v1/tasks/batch"]!;

    expect(await drive(v2, missing(), true)).toEqual({
      status: 422,
      retry: null,
      body: { error: PARENT_NOT_FOUND },
      changed: {},
    });
    expect(await drive(v3, missing(), true)).toEqual({
      status: 404,
      retry: null,
      body: { error: PARENT_NOT_FOUND },
      changed: {},
    });
    // Not waiting, nothing looks the parent up: the batch takes the parent id's shape.
    for (const [entry, wait, changed] of [
      [v2, false, { "runOps.taskRun": 2, "runOps.batchTaskRun": 1 }],
      [v3, false, { "runOps.batchTaskRun": 1 }],
      [v1, false, { "runOps.taskRun": 2, "runOps.batchTaskRun": 1 }],
      [v1, true, { "runOps.taskRun": 2, "runOps.batchTaskRun": 1 }],
    ] as const) {
      const before = await counts();
      const { status, body } = await answer(await entry(missing(), wait));
      expect(status).toBe(202);
      expect(shape(body.id)).toBe("gen1");
      expect(delta(before, await counts())).toEqual(changed);
    }
  });
});

const RECORDED_ROOT = { parentTaskRunId: null, rootTaskRunId: null, depth: 0 };
const RECORDED_ROOT_ROWS = { "runOps.taskRun": 1 };

// ---- A generation 3 parent (a run id on `m`) with a stand-in store under `m`: a child or batch is
// created only when a look-up finds that parent in the caller's environment, and then takes its
// shape. The organisation set-ups are the statement record's; the rule reads no flag.
const NEVER_ON = {
  activeRunStoreEnabled: true,
  checkpointStoreEnabled: true,
  clickhouseFeedEnabled: true,
  idempotencyStoreEnabled: true,
  batchStoreEnabled: true,
  archiveStoreEnabled: true,
  archiveReadPathEnabled: true,
  outflowEnabled: true,
  realtimeNativeOnly: true,
  waitpointStoreEnabled: true,
  realtimeBackend: "native",
};
const ON = { ...NEVER_ON, runResidencyEnabled: true };
const SETUPS: Record<string, Record<string, unknown> | undefined> = {
  plain: undefined,
  "never-on": NEVER_ON,
  "on-all-met": ON,
  "on-but-run-record-off": { ...ON, activeRunStoreEnabled: false },
};

const TRIGGER = "POST /api/v1/tasks/:taskId/trigger";
const V1_BATCH = "POST /api/v1/tasks/batch";
const V1_TASK_BATCH = "POST /api/v1/tasks/:taskId/batch";
const V2_BATCH = "POST /api/v2/tasks/batch";
const V3_BATCHES = "POST /api/v3/batches";

function expectStandInWroteNothing() {
  expect(holder.standInCalls.filter((name: string) => !name.startsWith("find"))).toEqual([]);
}

async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A parent run triggered through the engine; started, it can be blocked on a child or a batch.
async function parentRun(
  friendlyId: string,
  { environment = holder.environment, start = false }: { environment?: any; start?: boolean } = {}
) {
  const runId = RunId.fromFriendlyId(friendlyId);
  await holder.engine.trigger({
    number: 1,
    friendlyId,
    environment,
    taskIdentifier: TASK,
    payload: "{}",
    payloadType: "application/json",
    context: {},
    traceContext: {},
    traceId: "t12345",
    spanId: `s-${friendlyId}`,
    queue: `task/${TASK}`,
    isTest: false,
    tags: [],
    workerQueue: "main",
  });
  if (!start) return friendlyId;
  const message = await until(`dequeue ${friendlyId}`, async () => {
    const dequeued = await holder.engine.dequeueFromWorkerQueue({
      consumerId: "test",
      workerQueue: "main",
      blockingPop: false,
      skipObserving: true,
    });
    return dequeued.find((m: any) => m.run.id === runId);
  });
  await holder.engine.startRunAttempt({ runId, snapshotId: message.snapshot.id });
  return friendlyId;
}

// A second environment in the caller's organisation and project. Development, so the worker set-up
// writes no deployment, whose short code is fixed per project.
async function secondEnvironment() {
  const { project, organization } = holder.environment;
  const row = await holder.prisma14.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "tr_dev_other",
      pkApiKey: "pk_dev_other",
      shortcode: "dev",
    },
  });
  const other = await findEnvironmentById(row.id);
  await setupBackgroundWorker(holder.engine, other as never, [TASK]);
  return other;
}

// The item runs of a batch, read from both databases.
async function batchItems(batchFriendlyId: string) {
  const batchId = BatchId.fromFriendlyId(batchFriendlyId);
  const rows: { friendlyId: string; status: string }[] = [];
  for (const client of [holder.prisma14, holder.prisma17]) {
    rows.push(
      ...(await client.taskRun.findMany({
        where: { batchId },
        select: { friendlyId: true, status: true },
      }))
    );
  }
  return rows;
}

// A batch's shape, then its items' shapes.
async function batchShapes(batchFriendlyId: string) {
  const items = await batchItems(batchFriendlyId);
  return [shape(batchFriendlyId), ...items.map((item) => shape(item.friendlyId))];
}

// The streaming create, then two items streamed as NDJSON; settles when both items are runs.
async function streamedBatch(parent: string, wait: boolean) {
  const created = await answer(await ENTRIES[V3_BATCHES]!(parent, wait));
  expect(created.status).toBe(202);
  const batchId = created.body.id as string;
  const ndjson = [0, 1].map((index) => JSON.stringify({ index, task: TASK, payload: {} }));
  const res = (await v3ItemsAction(
    args(
      new Request(`http://localhost/api/v3/batches/${batchId}/items`, {
        method: "POST",
        headers: { "content-type": "application/x-ndjson", authorization: "Bearer api_key" },
        body: ndjson.join("\n") + "\n",
      }),
      { batchId }
    )
  )) as Response;
  expect(res.status).toBe(200);
  await until(`both items of ${batchId} are runs`, async () =>
    (await batchItems(batchId)).length === 2 ? true : undefined
  );
  return batchId;
}

describe("a generation 3 parent is found before its child or batch is created", () => {
  for (const setup of ["plain", "on-all-met"]) {
    // Catches: an entry point creating a child or batch of a generation 3 parent it did not find.
    routeTest(
      `${setup}: a generation 3 parent that names no run gets base's answer at every entry point`,
      async () => {
        for (const [name, entry] of Object.entries(ENTRIES)) {
          for (const wait of [false, true]) {
            holder.standInCalls = [];
            expect({ name, wait, ...(await drive(entry, runOn("m"), wait)) }).toEqual({
              name,
              wait,
              ...(UNCONFIGURED[name] as object),
            });
            expectStandInWroteNothing();
            holder.standInCalls = [];
            expect(await drive(entry, runOn("z"), wait)).toEqual(UNCONFIGURED[name]);
            expect(holder.standInCalls).toEqual([]);
          }
        }
        if (setup !== "plain") return;
        holder.canWriteRuns = false;
        holder.standInCalls = [];
        expect(await drive(ENTRIES[TRIGGER]!, runOn("m"), false)).toEqual({
          status: 404,
          retry: "false",
          body: { error: "Not Found" },
          changed: {},
        });
        expectStandInWroteNothing();
      },
      { standIn: true, flags: SETUPS[setup] }
    );
  }

  // Catches: a generation 3 parent in another environment of the organisation being found.
  routeTest(
    "plain: a generation 3 parent in another environment is not found from the caller's",
    async () => {
      const parent = await parentRun(runOn("m"), { environment: await secondEnvironment() });
      expect(await runRow(parent)).not.toBeNull();
      for (const name of [TRIGGER, V2_BATCH]) {
        for (const wait of [false, true]) {
          holder.standInCalls = [];
          expect({ name, wait, ...(await drive(ENTRIES[name]!, parent, wait)) }).toEqual({
            name,
            wait,
            ...(UNCONFIGURED[name] as object),
          });
          expectStandInWroteNothing();
        }
      }
    },
    { standIn: true }
  );

  for (const setup of ["on-all-met", "never-on", "on-but-run-record-off"]) {
    // Catches: a child, batch, item or born-terminal item of a found generation 3 parent losing its shape.
    routeTest(
      `${setup}: a found generation 3 parent gives its children, batches and items its shape`,
      async () => {
        // Started first, one at a time, while the queue holds nothing else to dequeue.
        const started: string[] = [];
        for (let i = 0; i < 4; i++) started.push(await parentRun(runOn("m"), { start: true }));
        const [triggerParent, v2Parent, streamedParent, v1TaskParent] = started;
        const idle = await parentRun(runOn("m"));
        const shapes: Record<string, string[]> = {};

        for (const wait of [false, true]) {
          const child = await answer(await ENTRIES[TRIGGER]!(wait ? triggerParent! : idle, wait));
          expect(child.status).toBe(200);
          shapes[`trigger wait=${wait}`] = [shape(child.body.id)];

          const v2 = await answer(await ENTRIES[V2_BATCH]!(wait ? v2Parent! : idle, wait));
          expect(v2.status).toBe(202);
          shapes[`v2 batch wait=${wait}`] = await batchShapes(v2.body.id);

          const streamed = await streamedBatch(wait ? streamedParent! : idle, wait);
          shapes[`streaming create wait=${wait}`] = await batchShapes(streamed);
        }

        const v1 = await answer(await ENTRIES[V1_BATCH]!(idle, false));
        expect(v1.status).toBe(202);
        shapes["v1 batch"] = await batchShapes(v1.body.id);

        // The trigger service refuses the second item (no worker has that version), so the batch
        // creates a born-terminal run for it.
        const failed = await answer(
          await v2BatchAction(
            args(
              post("http://localhost/api/v2/tasks/batch", {
                items: [
                  { task: TASK, payload: {} },
                  { task: TASK, payload: {}, options: { lockToVersion: "99990101.1" } },
                ],
                parentRunId: idle,
              })
            )
          )
        );
        expect(failed.status).toBe(202);
        const bornTerminal = (await batchItems(failed.body.id)).filter(
          (item) => item.status === "SYSTEM_FAILURE"
        );
        shapes["born-terminal item"] = bornTerminal.map((item) => shape(item.friendlyId));

        expect(shapes).toEqual({
          "trigger wait=false": ["gen2:m"],
          "v2 batch wait=false": ["gen2:m", "gen2:m", "gen2:m"],
          "streaming create wait=false": ["gen2:m", "gen2:m", "gen2:m"],
          "trigger wait=true": ["gen2:m"],
          "v2 batch wait=true": ["gen2:m", "gen2:m", "gen2:m"],
          "streaming create wait=true": ["gen2:m", "gen2:m", "gen2:m"],
          "v1 batch": ["gen2:m", "gen2:m", "gen2:m"],
          "born-terminal item": ["gen2:m"],
        });

        // The per-task batch sends no top-level parent, so its batch is a root's: a cuid batch on the
        // legacy database here. An item's child takes the batch's shape, never the parent's, and
        // base refuses it at the cross-database foreign key to its run-ops parent.
        const v1Task = ENTRIES[V1_TASK_BATCH]!;
        const root = await answer(await v1Task(undefined as never, false));
        expect(root.status).toBe(200);
        expect([shape(root.body.batchId), ...root.body.runs.map(shape)]).toEqual([
          "cuid",
          "cuid",
          "cuid",
        ]);
        for (const wait of [false, true]) {
          holder.standInCalls = [];
          expect(await drive(v1Task, wait ? v1TaskParent! : idle, wait)).toEqual({
            status: 400,
            retry: null,
            body: {
              error: expect.stringContaining(
                "Foreign key constraint violated on the constraint: `TaskRun_rootTaskRunId_fkey`"
              ),
            },
            changed: { "legacy.batchTaskRun": 1 },
          });
          expect(
            holder.standInCalls.filter((name: string) =>
              ["createRun", "createFailedRun", "createBatchTaskRun"].includes(name)
            )
          ).toEqual([]);
        }
      },
      { standIn: true, waitpointStore: true, flags: SETUPS[setup] }
    );
  }

  // Catches: a refusal placed before a look-up or a cached reply, or after the batch's item writes.
  routeTest(
    "plain: the refusal sits after the parent-write look-up, and after the v1 batch's cache and entitlement",
    async () => {
      const v1Batch = (body: Record<string, unknown>, idempotencyKey?: string) => {
        const request = post("http://localhost/api/v1/tasks/batch", body);
        if (idempotencyKey) request.headers.set("idempotency-key", idempotencyKey);
        return v1BatchAction(args(request)).then(answer);
      };
      const items = (key?: string) =>
        [0, 1].map(() => ({
          task: TASK,
          payload: {},
          options: key ? { idempotencyKey: key } : {},
        }));

      // A found generation 3 parent, without write:runs: the answer of any found parent (its child).
      const found = await parentRun(runOn("m"));
      const foundGen1 = await parentRun(RunId.toFriendlyId(generateRunOpsId()));
      holder.canWriteRuns = false;
      const trigger = ENTRIES[TRIGGER]!;
      for (const [parent, expected] of [
        [foundGen1, "gen1"],
        [found, "gen2:m"],
      ] as const) {
        const before = await counts();
        const child = await answer(await trigger(parent, false));
        expect({
          status: child.status,
          shape: child.body.id && shape(child.body.id),
          changed: delta(before, await counts()),
        }).toEqual({ status: 200, shape: expected, changed: { "runOps.taskRun": 1 } });
      }
      holder.canWriteRuns = true;

      // The cached reply comes before the look-up: a batch-level key answers with its batch.
      const first = await v1Batch({ items: items() }, "batch-key");
      expect(first.status).toBe(202);
      const cached = await v1Batch({ items: items(), parentRunId: runOn("m") }, "batch-key");
      expect({ status: cached.status, id: cached.body.id }).toEqual({
        status: 202,
        id: first.body.id,
      });

      // The entitlement check comes before the look-up.
      vi.mocked(getEntitlement).mockResolvedValueOnce({ hasAccess: false } as never);
      expect(await v1Batch({ items: items(), parentRunId: runOn("m") })).toEqual({
        status: 422,
        retry: null,
        body: { error: "You can't trigger a task because you have run out of credits." },
      });

      // The look-up comes before #prepareRunData, which clears the key of an expired cached item.
      const seeded = await v1Batch({ items: items("item-key") });
      expect(seeded.status).toBe(202);
      const itemRun = { friendlyId: seeded.body.runs[0].id };
      for (const client of [holder.prisma14, holder.prisma17]) {
        await client.taskRun.updateMany({
          where: itemRun,
          data: { idempotencyKeyExpiresAt: new Date(Date.now() - 60_000) },
        });
      }
      const refused = await v1Batch({ items: items("item-key"), parentRunId: runOn("m") });
      expect(refused.status).toBe(500);
      const keys = [];
      for (const client of [holder.prisma14, holder.prisma17]) {
        keys.push(
          ...(await client.taskRun.findMany({ where: itemRun, select: { idempotencyKey: true } }))
        );
      }
      expect(keys).toEqual([{ idempotencyKey: "item-key" }]);

      // The body's resumeParentOnCompletion is not passed on: a missing parent of another shape
      // still gives a batch of its shape, where a waiting look-up would answer 422.
      const unread = await v1Batch({
        items: items(),
        parentRunId: RunId.toFriendlyId(generateRunOpsId()),
        resumeParentOnCompletion: true,
      });
      expect({ status: unread.status, shape: unread.body.id && shape(unread.body.id) }).toEqual({
        status: 202,
        shape: "gen1",
      });
    },
    { standIn: true }
  );

  // Catches: a born-terminal item created for a generation 3 parent that its look-up did not find,
  // as when the parent was found at admission and is gone by the time the item fails.
  routeTest(
    "plain: a failed item whose generation 3 parent is not found creates no run",
    async () => {
      const service = new TriggerFailedTaskService({
        prisma: holder.prisma14,
        engine: holder.engine,
        runStore: holder.store,
      });
      const before = await counts();
      holder.standInCalls = [];

      const created = await service.call({
        taskId: TASK,
        environment: holder.environment,
        payload: {},
        errorMessage: "item failed",
        parentRunId: runOn("m"),
        runFriendlyId: runOn("m"),
      });

      expect(created).toBeNull();
      expect(holder.standInCalls.some((name: string) => name.startsWith("find"))).toBe(true);
      expectStandInWroteNothing();
      expect(delta(before, await counts())).toEqual({});
    },
    { standIn: true }
  );

  // Catches: a found cuid, generation 1 or shard a parent handing down another shape, or asking `m`.
  routeTest(
    "on-all-met: a found parent of any other shape gives its own shape and never asks the store under m",
    async () => {
      for (const [friendlyId, expected] of [
        [RunId.generate().friendlyId, "cuid"],
        [RunId.toFriendlyId(generateRunOpsId()), "gen1"],
        [runOn("a"), "gen2:a"],
      ] as const) {
        const parent = await parentRun(friendlyId);
        holder.standInCalls = [];
        const child = await answer(await ENTRIES[TRIGGER]!(parent, false));
        expect(child.status).toBe(200);
        const batch = await answer(await ENTRIES[V2_BATCH]!(parent, false));
        expect(batch.status).toBe(202);
        expect({
          child: shape(child.body.id),
          batch: await batchShapes(batch.body.id),
        }).toEqual({ child: expected, batch: [expected, expected, expected] });
        expect(holder.standInCalls).toEqual([]);
      }
    },
    { standIn: true, flags: ON }
  );
});

// ---- A new root of an enrolled organisation, in a process with a store under `m`: the decision at
// the four mint sites, with the rule's process inputs the test's own.
const ENROLLED = {
  ...ON,
  archiveStoreEnabled: false,
  outflowEnabled: false,
  idempotencyStoreEnabled: false,
  batchStoreEnabled: false,
};
const GEN3 = /^(run|batch)_[a-z0-9]{24}m2$/;
const GROUPS = [
  "parentAndChild",
  "batchMembership",
  "idempotencyKeyFields",
  "delayAndRescheduling",
  "debounce",
] as const;

// Replaces the organisation's flags (undefined: the plain organisation's) and reloads the environment.
async function useFlags(flags: Record<string, unknown> | undefined) {
  await holder.prisma14.organization.update({
    where: { id: holder.environment.organizationId },
    data: { featureFlags: flags ?? Prisma.DbNull },
  });
  holder.environment = await findEnvironmentById(holder.environment.id);
}

let unique = 0;
async function viaRoute(options: Record<string, unknown>, headers: Record<string, string> = {}) {
  const request = post(`http://localhost/api/v1/tasks/${TASK}/trigger`, { payload: {}, options });
  for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
  const res = await answer(await triggerAction(args(request, { taskId: TASK })));
  expect(res.status).toBe(200);
  return res.body.id as string;
}

// As the webhook engine and other workers call it: no request scope.
async function direct(options: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const result = await new TriggerTaskService().call(
    TASK,
    holder.environment,
    { payload: {}, ...body },
    options
  );
  return result!.run.friendlyId;
}

const WEBHOOK = {
  triggerSource: "webhook",
  triggerAction: "trigger",
  customIcon: "webhook",
  webhookDeliveryId: "whd_test",
  webhookEndpointId: "whep_test",
};

const ROOTS: Record<string, () => Promise<string>> = {
  simple: () => viaRoute({}),
  "Idempotency-Key header": () => viaRoute({}, { "idempotency-key": `header-${++unique}` }),
  "body idempotencyKey": () => viaRoute({ idempotencyKey: `body-${++unique}` }),
  delayed: () => viaRoute({ delay: "1h" }),
  debounced: () => viaRoute({ debounce: { key: `debounce-${++unique}`, delay: "1h" } }),
  "delayed and debounced": () =>
    viaRoute({ delay: "1h", debounce: { key: `debounce-${++unique}`, delay: "1h" } }),
  token: () => direct({ oneTimeUseToken: `token-${++unique}` }),
  "token and key": () =>
    direct({ oneTimeUseToken: `token-${++unique}`, idempotencyKey: `token-key-${unique}` }),
  webhook: () =>
    direct(
      {
        ...WEBHOOK,
        idempotencyKey: `whep_test:delivery-${++unique}`,
        idempotencyKeyExpiresAt: new Date(Date.now() + 86_400_000),
      },
      { options: { tags: ["webhook:endpoint:whep_test"] } }
    ),
  // A delivery to a session target carries no idempotency key.
  "session target": () => direct(WEBHOOK, { options: { tags: ["webhook:endpoint:whep_test"] } }),
};

async function shapesOf(names: string[]) {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = shape(await ROOTS[name]!());
  return out;
}

const every = (names: string[], value: string) =>
  Object.fromEntries(names.map((name) => [name, value]));

function rootRow(friendlyId: string) {
  return Promise.all(
    [holder.prisma14, holder.prisma17].map((client) =>
      client.taskRun.findFirst({ where: { friendlyId }, select: { id: true } })
    )
  ).then(([legacy, runOps]) => ({ legacy: !!legacy, runOps: !!runOps }));
}

function batchRow(friendlyId: string) {
  return Promise.all(
    [holder.prisma14, holder.prisma17].map((client) =>
      client.batchTaskRun.findFirst({ where: { friendlyId }, select: { id: true } })
    )
  ).then(([legacy, runOps]) => ({ legacy: !!legacy, runOps: !!runOps }));
}

// A root batch from each route; [batch shape, ...item shapes].
const ROOT_BATCHES: Record<string, () => Promise<string[]>> = {
  [V1_BATCH]: async () => {
    const res = await answer(await ENTRIES[V1_BATCH]!(undefined as never, false));
    expect(res.status).toBe(202);
    return batchShapes(res.body.id);
  },
  [V1_TASK_BATCH]: async () => {
    const res = await answer(await ENTRIES[V1_TASK_BATCH]!(undefined as never, false));
    expect(res.status).toBe(200);
    return batchShapes(res.body.batchId);
  },
  [V2_BATCH]: async () => {
    const res = await answer(await ENTRIES[V2_BATCH]!(undefined as never, false));
    expect(res.status).toBe(202);
    return batchShapes(res.body.id);
  },
  [V3_BATCHES]: async () => batchShapes(await streamedBatch(undefined as never, false)),
};

async function rootBatchShapes(names: string[]) {
  const out: Record<string, string[]> = {};
  for (const name of names) out[name] = await ROOT_BATCHES[name]!();
  return out;
}

const mintArgs = () => ({
  environment: {
    organizationId: holder.environment.organizationId,
    id: holder.environment.id,
    orgFeatureFlags: holder.environment.organization.featureFlags,
  },
  parentRunFriendlyId: undefined,
});

describe("a new root of an enrolled organisation, with a store under m", () => {
  // Catches: the trigger API not minting a generation 3 simple root for the enrolled org, writing it
  // anywhere but the store under m, depending on the mint master switch, or not marking the request.
  routeTest(
    "the trigger API: an enrolled simple root is generation 3 and born here; the plain org's is not",
    async () => {
      const seen: boolean[] = [];
      const original = IdempotencyKeyConcern.prototype.handleTriggerRequest;
      const spy = vi.spyOn(IdempotencyKeyConcern.prototype, "handleTriggerRequest");
      spy.mockImplementation(function (this: IdempotencyKeyConcern, ...callArgs) {
        seen.push(organizationContext.get()?.bornHere === true);
        return original.apply(this, callArgs);
      });
      try {
        const before = await counts();
        const enrolled = await answer(await ENTRIES[TRIGGER]!(undefined as never, false));
        expect(enrolled.body.id).toMatch(GEN3);
        expect(holder.standInCalls).toContain("createRun");
        expect(holder.standInContexts.every((call) => call.bornHere)).toBe(true);
        expect(delta(before, await counts())).toEqual({ "runOps.taskRun": 1 });
        expect(await rootRow(enrolled.body.id)).toEqual({ legacy: false, runOps: true });

        await useFlags({ ...ENROLLED, idempotencyStoreEnabled: true });
        holder.standInContexts = [];
        const keyed = await ROOTS["Idempotency-Key header"]!();
        expect(keyed).toMatch(GEN3);
        expect(holder.standInContexts.length).toBeGreaterThan(0);
        expect(holder.standInContexts.every((call) => call.bornHere)).toBe(true);
        expect(seen).toEqual([true, true]);

        await useFlags(undefined);
        holder.standInCalls = [];
        const plain = await answer(await ENTRIES[TRIGGER]!(undefined as never, false));
        expect(plain.status).toBe(enrolled.status);
        expect(shape(plain.body.id)).toBe("cuid");
        expect(holder.standInCalls).toEqual([]);
        expect(seen).toEqual([true, true, false]);
      } finally {
        spy.mockRestore();
      }

      // Inside a scope, as a request has one: a direct call marks it only for a generation 3 id.
      const scoped = async (options: Record<string, unknown> = {}) => {
        const ctx: { bornHere?: boolean } = {};
        const id = await organizationContext.run(ctx, () => direct(options));
        return { shape: shape(id), bornHere: ctx.bornHere === true };
      };
      expect(await scoped()).toEqual({ shape: "cuid", bornHere: false });
      const supplied = RunId.toFriendlyId(generateRunOpsIdV2(MEMORYDB_SHARD_KEY));
      expect(await scoped({ runFriendlyId: supplied })).toEqual({
        shape: "gen2:m",
        bornHere: true,
      });
      await useFlags(ENROLLED);
      expect(await scoped()).toEqual({ shape: "gen2:m", bornHere: true });

      // Catches: a caller-supplied id or a child asking the decision.
      holder.ruleCalls = 0;
      const verbatim = RunId.generate().friendlyId;
      expect(await direct({ runFriendlyId: verbatim })).toBe(verbatim);
      const parent = await parentRun(RunId.toFriendlyId(generateRunOpsId()));
      const child = await answer(await ENTRIES[TRIGGER]!(parent, false));
      expect(shape(child.body.id)).toBe("gen1");
      expect(holder.ruleCalls).toBe(0);
    },
    { standIn: true, flags: ENROLLED }
  );

  // Catches: a keyed, token, delayed or debounced root admitted without its flag or group.
  routeTest(
    "single roots: each kind by its idempotency flag and its groups",
    async () => {
      const all = Object.keys(ROOTS);
      await useFlags({ ...ENROLLED, idempotencyStoreEnabled: true });
      expect(await shapesOf(all)).toEqual(every(all, "gen2:m"));

      const keyed = ["Idempotency-Key header", "body idempotencyKey", "token", "token and key"];
      await useFlags(ENROLLED);
      expect(await shapesOf([...keyed, "webhook", "session target"])).toEqual({
        ...every([...keyed, "webhook"], "cuid"),
        "session target": "gen2:m",
      });

      await useFlags({ ...ENROLLED, idempotencyStoreEnabled: true });
      holder.unsupportedGroups = ["idempotencyKeyFields"];
      expect(await shapesOf(["body idempotencyKey"])).toEqual({ "body idempotencyKey": "cuid" });
      // A debounced run is always delayed, so it needs this group too.
      holder.unsupportedGroups = ["delayAndRescheduling"];
      expect(await shapesOf(["delayed", "debounced", "delayed and debounced"])).toEqual(
        every(["delayed", "debounced", "delayed and debounced"], "cuid")
      );
      holder.unsupportedGroups = ["debounce"];
      expect(await shapesOf(["debounced"])).toEqual({ debounced: "cuid" });

      holder.unsupportedGroups = undefined;
      const published = all.filter((name) => name !== "simple" && name !== "session target");
      expect(await shapesOf(all)).toEqual({
        ...every(published, "cuid"),
        simple: "gen2:m",
        "session target": "gen2:m",
      });
    },
    { standIn: true, flags: ENROLLED }
  );

  // Catches: a root batch admitted without the batches flag, a group or the idempotency condition,
  // a version 1 endpoint minting generation 3, or items not taking the batch's shape.
  routeTest(
    "root batches: version 2 and streaming by the batches flag; version 1 keeps today's mint",
    async () => {
      const all = [V1_BATCH, V1_TASK_BATCH, V2_BATCH, V3_BATCHES];
      const today = ["cuid", "cuid", "cuid"];
      const gen3 = ["gen2:m", "gen2:m", "gen2:m"];
      const mint = vi.mocked(mintBatchFriendlyId);
      // Today's mint: one call of mintBatchFriendlyId with base's arguments.
      const todayBatch = async (name: string) => {
        mint.mockClear();
        const shapes = await ROOT_BATCHES[name]!();
        expect({ name, calls: mint.mock.calls }).toEqual({ name, calls: [[mintArgs()]] });
        return shapes;
      };

      expect(await rootBatchShapes([V1_BATCH, V1_TASK_BATCH])).toEqual({
        [V1_BATCH]: today,
        [V1_TASK_BATCH]: today,
      });
      expect(await todayBatch(V2_BATCH)).toEqual(today);
      expect(await todayBatch(V3_BATCHES)).toEqual(today);

      await useFlags({ ...ENROLLED, batchStoreEnabled: true, idempotencyStoreEnabled: true });
      holder.standInContexts = [];
      expect(await rootBatchShapes(all)).toEqual({
        [V1_BATCH]: today,
        [V1_TASK_BATCH]: today,
        [V2_BATCH]: gen3,
        [V3_BATCHES]: gen3,
      });
      const created = holder.standInContexts.filter((c) => c.method === "createBatchTaskRun");
      expect(created.map((c) => c.bornHere)).toEqual([true, true]);

      await useFlags({ ...ENROLLED, batchStoreEnabled: true });
      expect(await rootBatchShapes([V1_BATCH, V1_TASK_BATCH, V2_BATCH])).toEqual({
        [V1_BATCH]: today,
        [V1_TASK_BATCH]: today,
        [V2_BATCH]: gen3,
      });
      expect(await todayBatch(V3_BATCHES)).toEqual(today);
      mint.mockClear();
      const keyedItem = await answer(
        await v2BatchAction(
          args(
            post("http://localhost/api/v2/tasks/batch", {
              items: [
                { task: TASK, payload: {} },
                { task: TASK, payload: {}, options: { idempotencyKey: `item-${++unique}` } },
              ],
            })
          )
        )
      );
      expect(keyedItem.status).toBe(202);
      expect(await batchShapes(keyedItem.body.id)).toEqual(today);
      expect(mint.mock.calls).toEqual([[mintArgs()]]);
      mint.mockClear();
      const token = await new RunEngineBatchTriggerService().call(
        holder.environment,
        { items: [{ task: TASK, payload: {} }] } as never,
        { oneTimeUseToken: `batch-token-${++unique}` }
      );
      expect(shape(token.id)).toBe("cuid");
      expect(mint.mock.calls).toEqual([[mintArgs()]]);

      await useFlags({ ...ENROLLED, batchStoreEnabled: true, idempotencyStoreEnabled: true });
      for (const group of GROUPS) {
        holder.unsupportedGroups = [group];
        expect({
          group,
          [V2_BATCH]: await todayBatch(V2_BATCH),
          [V3_BATCHES]: await todayBatch(V3_BATCHES),
        }).toEqual({ group, [V2_BATCH]: today, [V3_BATCHES]: today });
      }

      holder.unsupportedGroups = [];
      const v2 = await answer(await ENTRIES[V2_BATCH]!(undefined as never, false));
      expect(await batchRow(v2.body.id)).toEqual({ legacy: false, runOps: true });
    },
    { standIn: true, flags: ENROLLED }
  );

  // Catches: a condition of the rule ignored at the mint, a never-on org admitted, or a refused root
  // not taking today's call with base's arguments.
  routeTest(
    "the rule's conditions at the mint, never-on, and a throw",
    async () => {
      const mint = vi.mocked(resolveRunMintTarget);
      const simpleToday = async () => {
        mint.mockClear();
        const id = await ROOTS.simple!();
        expect(mint.mock.calls).toEqual([[{ ...mintArgs(), region: undefined }]]);
        return shape(id);
      };
      const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
        ["no snapshot store URL", { RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL: "" }, {}, "cuid"],
        ["no waitpoint store URL", { RUN_ENGINE_WAITPOINT_STORE_REDIS_URL: "" }, {}, "cuid"],
        [
          "native realtime off, not native-only",
          { REALTIME_BACKEND_NATIVE_ENABLED: "0" },
          { realtimeNativeOnly: false },
          "cuid",
        ],
        ["native-only, backend electric", {}, { realtimeBackend: "electric" }, "gen2:m"],
        ["native-only, backend shadow", {}, { realtimeBackend: "shadow" }, "gen2:m"],
        [
          "native-only, native realtime off",
          { REALTIME_BACKEND_NATIVE_ENABLED: "0" },
          {},
          "gen2:m",
        ],
      ];
      const defaults = { ...holder.residencyEnv };
      for (const [name, envPatch, flagPatch, expected] of cases) {
        holder.residencyEnv = { ...defaults, ...envPatch };
        await useFlags({ ...ENROLLED, ...flagPatch });
        const got = expected === "cuid" ? await simpleToday() : shape(await ROOTS.simple!());
        expect({ name, got }).toEqual({ name, got: expected });
      }
      holder.residencyEnv = defaults;

      await useFlags(NEVER_ON);
      holder.standInCalls = [];
      const keyed = async () => {
        mint.mockClear();
        const id = await ROOTS["body idempotencyKey"]!();
        expect(mint.mock.calls).toEqual([[{ ...mintArgs(), region: undefined }]]);
        return shape(id);
      };
      expect(await keyed()).toBe("cuid");
      const batchMint = vi.mocked(mintBatchFriendlyId);
      for (const name of [V2_BATCH, V3_BATCHES]) {
        batchMint.mockClear();
        expect(await ROOT_BATCHES[name]!()).toEqual(["cuid", "cuid", "cuid"]);
        expect(batchMint.mock.calls).toEqual([[mintArgs()]]);
      }
      expect(holder.standInCalls).toEqual([]);

      // Catches: a throw in the decision escaping, giving generation 3, or warning other than once.
      await useFlags(ENROLLED);
      const warn = vi.spyOn(logger, "warn");
      try {
        holder.unsupportedGroups = new Error("groups unreadable");
        expect(shape(await ROOTS.delayed!())).toBe("cuid");
        expect(
          warn.mock.calls.filter(([message]) => message === "runResidency.root_decision_failed")
        ).toEqual([["runResidency.root_decision_failed", { error: "groups unreadable" }]]);
        holder.unsupportedGroups = [];
        holder.globalFlags = new Error("global flags unreadable");
        expect(shape(await ROOTS.simple!())).toBe("cuid");
        expect(
          warn.mock.calls.filter(([message]) => message === "runResidency.rule_failed")
        ).toEqual([["runResidency.rule_failed", { error: "global flags unreadable" }]]);
      } finally {
        warn.mockRestore();
        holder.globalFlags = undefined;
      }
    },
    { standIn: true, flags: ENROLLED }
  );

  // Catches: a root born under m in a process with no store registered there.
  routeTest(
    "no store under m: an enrolled simple root gets today's id and the rule is not asked",
    async () => {
      expect(shape(await ROOTS.simple!())).toBe("cuid");
      expect(holder.ruleCalls).toBe(0);
    },
    { flags: ENROLLED }
  );
});

// ---- The parent rule for an enrolled organisation: a generation 3 root's children and batches
// keep its shape whatever the switch and the run record flag say, and a generation 3 parent that
// names no run gets base's answer.
describe("the parent rule for an enrolled organisation, across the switch", () => {
  // Catches: a gen 3 root's child or batch losing its shape, or a missing gen 3 parent making one.
  routeTest(
    "an enrolled root's children and batches stay generation 3; a missing generation 3 parent gets base's answer",
    async () => {
      const root = await answer(await ENTRIES[TRIGGER]!(undefined as never, false));
      expect(root.status).toBe(200);
      expect(root.body.id).toMatch(GEN3);
      const gen3 = ["gen2:m", "gen2:m", "gen2:m"];
      const states: Array<[string, Record<string, unknown>, string]> = [
        ["enrolled", ENROLLED, "gen2:m"],
        [
          "switch off, stamp recording on",
          {
            ...ENROLLED,
            runResidencyEnabled: false,
            runResidencyEnabledPrev: true,
            runResidencyEnabledFlippedAt: "2026-01-01T00:00:00.000Z",
          },
          "cuid",
        ],
        ["run record flag off", { ...ENROLLED, activeRunStoreEnabled: false }, "cuid"],
      ];
      for (const [state, flags, simple] of states) {
        await useFlags(flags);
        const child = await answer(await ENTRIES[TRIGGER]!(root.body.id, false));
        expect({ state, status: child.status }).toEqual({ state, status: 200 });
        const v2 = await answer(await ENTRIES[V2_BATCH]!(root.body.id, false));
        expect({ state, status: v2.status }).toEqual({ state, status: 202 });
        expect({
          state,
          child: shape(child.body.id),
          v2: await batchShapes(v2.body.id),
          streaming: await batchShapes(await streamedBatch(root.body.id, false)),
          simple: shape(await ROOTS.simple!()),
        }).toEqual({ state, child: "gen2:m", v2: gen3, streaming: gen3, simple });
      }

      await useFlags(ENROLLED);
      for (const [name, entry] of Object.entries(ENTRIES)) {
        for (const wait of [false, true]) {
          holder.standInCalls = [];
          expect({ name, wait, ...(await drive(entry, runOn("m"), wait)) }).toEqual({
            name,
            wait,
            ...(UNCONFIGURED[name] as object),
          });
          expectStandInWroteNothing();
        }
      }
    },
    { standIn: true, flags: ENROLLED }
  );
});
