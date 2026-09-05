// The per-organisation ramp is the canonical procedure: deployment dial down, one organisation opted
// in. Asserted at the CALL SITES, because a predicate seam cannot show a birth and that same run's
// transitions disagreeing, which is the whole failure. A recording append and a sentinel delegate
// answer the only question here, which is who reaches Redis, so no containers are involved; the
// behavioural suites for these sites run against a real Postgres and a real Redis.
import { describe, expect, it } from "vitest";
import type { RedisSnapshotStore, SnapshotEntryInput } from "./redisSnapshotStore.js";
import type { RunRegime } from "./runRegimeCache.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

const ORG = "org_ramp";
const RUN = "run_ramp";

const SCOPE = {
  environmentId: "env_1",
  environmentType: "PRODUCTION",
  projectId: "proj_1",
  organizationId: ORG,
} as const;

function harness(global: SnapshotStoreMode, perOrg: SnapshotStoreMode) {
  const appends: { kind: string; entry: SnapshotEntryInput }[] = [];

  const regime = new Map<string, RunRegime>();
  const redis = {
    append: async (args: { entry: SnapshotEntryInput; kind: string }) => {
      appends.push({ kind: args.kind, entry: args.entry });
      return { outcome: "written" as const, seq: appends.length };
    },
    regimeFor: (runId: string) => regime.get(runId),
    recordRegime: (runId: string, r: RunRegime) => {
      regime.set(runId, r);
    },
  } as unknown as RedisSnapshotStore;

  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => () =>
      Promise.resolve(prop === "expireParkedRun" ? { count: 1 } : {}),
  }) as unknown as RunStore;

  const modeResolver = {
    resolve: (organizationId?: string) => (organizationId === ORG ? perOrg : global),
  } satisfies SnapshotStoreModeResolver;

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: global,
    modeResolver,
  });

  return { decorated, appends };
}

async function births(store: TaskRunExecutionSnapshotStore): Promise<void> {
  await store.createRun({
    data: { id: RUN } as never,
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run created",
      runStatus: "PENDING",
      ...SCOPE,
    },
  });

  await store.createCancelledRun({
    data: { id: `${RUN}_cancelled` } as never,
    snapshot: {
      engine: "V2",
      executionStatus: "FINISHED",
      description: "Run was cancelled",
      runStatus: "CANCELED",
      ...SCOPE,
    },
  });
}

async function transitions(store: TaskRunExecutionSnapshotStore): Promise<void> {
  await store.completeAttemptSuccess(
    RUN,
    {
      completedAt: new Date(),
      outputType: "application/json",
      usageDurationMs: 1,
      costInCents: 0,
      snapshot: {
        executionStatus: "FINISHED",
        description: "Attempt succeeded",
        runStatus: "COMPLETED_SUCCESSFULLY",
        attemptNumber: 1,
        ...SCOPE,
      },
    },
    { select: { id: true } }
  );

  const expireSnapshot = {
    engine: "V2",
    executionStatus: "FINISHED",
    description: "Run expired",
    runStatus: "EXPIRED",
    ...SCOPE,
  } as const;

  await store.expireRun(
    RUN,
    { error: {}, completedAt: new Date(), expiredAt: new Date(), snapshot: expireSnapshot },
    { select: { id: true } }
  );

  await store.expireParkedRun(RUN, {
    error: {},
    completedAt: new Date(),
    expiredAt: new Date(),
    statusReason: "expired",
    snapshot: expireSnapshot,
  });

  await store.rescheduleRun(RUN, { delayUntil: new Date(), snapshot: { ...SCOPE } });

  await store.lockRunToWorker(RUN, {
    lockedAt: new Date(),
    lockedById: "worker_1",
    lockedToVersionId: "version_1",
    lockedQueueId: "queue_1",
    startedAt: new Date(),
    baseCostInCents: 0,
    machinePreset: "small-1x",
    taskVersion: "1.0.0",
    sdkVersion: null,
    cliVersion: null,
    maxDurationInSeconds: null,
    snapshot: {
      id: "snap_lock",
      previousSnapshotId: "snap_previous",
      completedWaitpointIds: [],
      completedWaitpointOrder: [],
      ...SCOPE,
    },
  });

  await store.createExecutionSnapshot({
    run: { id: RUN, status: "EXECUTING" },
    snapshot: { executionStatus: "EXECUTING", description: "Executing" },
    ...SCOPE,
  });
}

const TRANSITION_COUNT = 6;

describe("the per-organisation ramp", () => {
  it("mirrors a birth AND that run's transitions for an organisation opted in past a dial at off", async () => {
    const { decorated, appends } = harness("off", "dual-write");

    await births(decorated);
    expect(appends.map((a) => a.kind)).toEqual(["birth", "birth"]);

    appends.length = 0;
    await transitions(decorated);
    expect(appends).toHaveLength(TRANSITION_COUNT);
    expect(appends.every((a) => a.kind === "transition")).toBe(true);
  });

  // Named for what it can prove. It asserts which CALL SITES reach Redis, which is a seam-level
  // property: the append here is a recording double, so no keyspace exists and residency itself is
  // not exercised. That a RESIDENT run keeps mirroring after its organisation moves to off is
  // covered against real infrastructure elsewhere, and was verified by hand as well: a run born at
  // dual-write went from 3 entries to 8 with its head matching Postgres after the organisation was
  // pinned off mid-flight.
  it("asks Redis at no birth site for an organisation held at off, and still asks at every transition site", async () => {
    const { decorated, appends } = harness("dual-write", "off");

    await births(decorated);
    expect(appends).toHaveLength(0);

    // Residency is the keyspace, and the append script refuses a transition into one that does not
    // exist. Asking the organisation again here is what lets a run change stores mid-life.
    await transitions(decorated);
    expect(appends).toHaveLength(TRANSITION_COUNT);
  });
});
