import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimAlertForEvaluation,
  createAlert,
  getAlert,
  listAlertEvents,
  resolveAlert,
} from "../storage/alertStore.server";
import type { PrismaClient } from "@trigger.dev/database";
import { rawSqlClient, startAlertsPostgres } from "../../../../../test/helpers/alertTables";
import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { CronSchema, Worker } from "@trigger.dev/redis-worker";
import { Redis, type RedisOptions } from "ioredis";
import { z } from "zod";
import { getCapability, type EvaluationResult } from "@internal/alert-contracts";
import { LANE_RETRY_MAX_MS, LANE_RETRY_MIN_MS, alertPhaseOffsetMs } from "./alertSchedule";
import type { EvaluateBindingFn } from "./evaluateAlert.server";
import {
  alertEvaluationJobId,
  alertEvaluationJobs,
  EVALUATION_LEASE_GRACE_MS,
  nextRunAt,
  runEvaluateAlertJob,
  type EvaluateAlertJobDeps,
} from "./evaluateAlertJob.server";
import {
  BOOT_RECONCILE_JOB_ID,
  enqueueBootReconcile,
  reconcileAlertJobs,
  redisReconcileCursorStore,
} from "./reconcileAlertJobs.server";

vi.setConfig({ testTimeout: 120_000 });

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;
let rawSql: ReturnType<typeof rawSqlClient>;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
  rawSql = rawSqlClient(db);
}, 180_000);

afterAll(async () => {
  await pg?.stop();
});

beforeEach(async () => {
  await rawSql`DELETE FROM "AlertDelivery"`;
  await rawSql`DELETE FROM "AlertEvent"`;
  await rawSql`DELETE FROM "Alert"`;
});

const BASE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  capabilityKey: "queue.depth",
  params: { queue: "worker-1" } as Record<string, unknown>,
  condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 } as Record<
    string,
    unknown
  >,
  createdBy: "user_1",
  notifiers: [],
};

function seed(overrides: Partial<Parameters<typeof createAlert>[1]> = {}) {
  return createAlert(db, { ...BASE, nextEvaluationAt: new Date(Date.now() - 1_000), ...overrides });
}

const met: EvaluationResult = { kind: "stateful", outcome: "met", facts: { value: 150 } };

function createWorker(redisOptions: RedisOptions) {
  return new Worker({
    name: "alert-engine-test",
    redisOptions: { ...redisOptions, keyPrefix: "alerts:engine:" },
    catalog: {
      "alerts.evaluate": {
        schema: z.object({ alertId: z.string() }),
        visibilityTimeoutMs: 120_000,
        retry: { maxAttempts: 2 },
      },
      "alerts.reconcile": {
        schema: CronSchema,
        visibilityTimeoutMs: 300_000,
        retry: { maxAttempts: 1 },
      },
    },
    jobs: {
      "alerts.evaluate": async () => {},
      "alerts.reconcile": async () => {},
    },
    logger: new Logger("test", "error"),
  });
}

function jobDeps(
  worker: ReturnType<typeof createWorker>,
  evaluateBinding: EvaluateBindingFn = async () => ({ result: met })
): EvaluateAlertJobDeps {
  return {
    db,
    evaluateBinding,
    enqueueDelivery: async () => {},
    leaseMs: 120_000,
    enqueue: alertEvaluationJobs(worker).enqueue,
    isOrganizationEnabled: async () => true,
  };
}

async function job(worker: ReturnType<typeof createWorker>, alertId: string) {
  return worker.getJob(alertEvaluationJobId(alertId));
}

describe("runEvaluateAlertJob", () => {
  redisTest("enqueues the next slot after evaluating a due alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();

    await runEvaluateAlertJob({ alertId: alert.id, now: new Date() }, jobDeps(worker));

    const stored = await getAlert(db, { id: alert.id });
    expect(stored!.nextEvaluationAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(
      stored!.nextEvaluationAt!.getTime()
    );
    await worker.stop();
  });

  redisTest("re-enqueues a not-due alert without evaluating", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const dueAt = new Date(Date.now() + 60_000);
    const alert = await seed({ nextEvaluationAt: dueAt });
    let bindingCalls = 0;

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date() },
      jobDeps(worker, async () => {
        bindingCalls++;
        return { result: met };
      })
    );

    expect(bindingCalls).toBe(0);
    expect(await listAlertEvents(db, alert.id)).toHaveLength(0);
    expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(dueAt.getTime());
    await worker.stop();
  });

  redisTest("re-enqueues a leased alert at its lease end", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const leaseUntil = new Date(Date.now() + 90_000);
    const alert = await seed({
      evaluationLeaseId: "lease_other",
      evaluationLeaseUntil: leaseUntil,
    });

    await runEvaluateAlertJob({ alertId: alert.id, now: new Date() }, jobDeps(worker));

    expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(leaseUntil.getTime());
    await worker.stop();
  });

  redisTest("a redelivered job sees a running evaluation as leased", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();
    const visibilityMs = 120_000;
    const claimedAt = new Date();
    const claim = await claimAlertForEvaluation(db, {
      id: alert.id,
      now: claimedAt,
      leaseMs: visibilityMs + EVALUATION_LEASE_GRACE_MS,
    });
    expect(claim.claimed).toBe(true);
    let bindingCalls = 0;

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date(claimedAt.getTime() + visibilityMs + 1_000) },
      jobDeps(worker, async () => {
        bindingCalls++;
        return { result: met };
      })
    );

    const leaseUntil = (await getAlert(db, { id: alert.id }))!.evaluationLeaseUntil!;
    expect(bindingCalls).toBe(0);
    expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(leaseUntil.getTime());
    await worker.stop();
  });

  redisTest("drops an active alert past its expiry", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed({ expiresAt: new Date(Date.now() - 60_000) });
    let bindingCalls = 0;

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date() },
      jobDeps(worker, async () => {
        bindingCalls++;
        return { result: met };
      })
    );

    expect(bindingCalls).toBe(0);
    expect(await listAlertEvents(db, alert.id)).toHaveLength(0);
    expect(await job(worker, alert.id)).toBeNull();
    await worker.stop();
  });

  redisTest("a binding failure logs and re-enqueues the next slot", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();
    const errors: Array<[string, Record<string, unknown>]> = [];
    const startedAt = Date.now();

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date() },
      {
        ...jobDeps(worker, async () => {
          throw new Error("boom");
        }),
        logger: { debug: () => {}, error: (message, attrs) => errors.push([message, attrs]) },
      }
    );

    expect(errors).toContainEqual([
      "alerts.evaluate.binding_failed",
      expect.objectContaining({ alertId: alert.id, capabilityKey: alert.capabilityKey }),
    ]);
    const nextAt = (await job(worker, alert.id))!.timestamp.getTime();
    const cadenceMs = getCapability(alert.capabilityKey)!.minCadenceSec * 1000;
    expect(nextAt).toBeGreaterThan(startedAt);
    expect((nextAt - alertPhaseOffsetMs(alert.id)) % cadenceMs).toBe(0);
    expect((await getAlert(db, { id: alert.id }))!.nextEvaluationAt!.getTime()).toBe(nextAt);
    await worker.stop();
  });

  redisTest("a lane rejection re-enqueues at the stored retry time", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();
    const startedAt = Date.now();

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date() },
      jobDeps(worker, async () => {
        throw Object.assign(new Error("lane full"), { __queryConcurrencyRejection: true });
      })
    );

    const retryAt = (await getAlert(db, { id: alert.id }))!.nextEvaluationAt!.getTime();
    expect(retryAt - startedAt).toBeGreaterThanOrEqual(LANE_RETRY_MIN_MS);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(LANE_RETRY_MAX_MS);
    expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(retryAt);
    await worker.stop();
  });

  redisTest("drops the job for a stopped alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed({ lifecycle: "stopped" });

    await runEvaluateAlertJob({ alertId: alert.id, now: new Date() }, jobDeps(worker));

    expect(await job(worker, alert.id)).toBeNull();
    await worker.stop();
  });

  redisTest("keeps a job when the alert is resolved mid-evaluation", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed({ attention: "needs_attention", observedCondition: "met" });

    await runEvaluateAlertJob(
      { alertId: alert.id, now: new Date() },
      jobDeps(worker, async () => {
        await resolveAlert(db, { id: alert.id, actorId: "user_1" });
        return { result: met };
      })
    );

    expect((await getAlert(db, { id: alert.id }))!.lifecycle).toBe("active");
    expect(await job(worker, alert.id)).not.toBeNull();
    await worker.stop();
  });

  redisTest("a throw after commit does not evaluate twice", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();
    let bindingCalls = 0;
    const deps = jobDeps(worker, async () => {
      bindingCalls++;
      return { result: met };
    });
    const now = new Date();

    await expect(
      runEvaluateAlertJob(
        { alertId: alert.id, now },
        {
          ...deps,
          enqueue: async () => {
            throw new Error("redis down");
          },
        }
      )
    ).rejects.toThrow("redis down");
    expect(await job(worker, alert.id)).toBeNull();

    await runEvaluateAlertJob({ alertId: alert.id, now }, deps);

    expect(bindingCalls).toBe(1);
    expect(await listAlertEvents(db, alert.id)).toHaveLength(1);
    expect(await job(worker, alert.id)).not.toBeNull();
    await worker.stop();
  });

  redisTest(
    "releases the lease and requeues at the next cadence when the org flag is off",
    async ({ redisOptions }) => {
      const worker = createWorker(redisOptions);
      const alert = await seed();
      let bindingCalls = 0;
      const checked: string[] = [];
      const deps = jobDeps(worker, async () => {
        bindingCalls++;
        return { result: met };
      });

      const result = await runEvaluateAlertJob(
        { alertId: alert.id, now: new Date() },
        {
          ...deps,
          isOrganizationEnabled: async (organizationId) => {
            checked.push(organizationId);
            return false;
          },
        }
      );

      const stored = (await getAlert(db, { id: alert.id }))!;
      expect(checked).toEqual([BASE.organizationId]);
      expect(bindingCalls).toBe(0);
      expect(await listAlertEvents(db, alert.id)).toHaveLength(0);
      expect(stored.evaluationLeaseId).toBeNull();
      expect(stored.evaluationLeaseUntil).toBeNull();
      expect(stored.nextEvaluationAt!.getTime()).toBeGreaterThan(Date.now());
      expect(result.nextAt).toEqual(stored.nextEvaluationAt);
      expect((await job(worker, alert.id))?.timestamp.getTime()).toBe(
        stored.nextEvaluationAt!.getTime()
      );
      await worker.stop();
    }
  );
});

describe("nextRunAt", () => {
  it("retries after 5s when neither due time nor lease is set", () => {
    const now = new Date();
    expect(nextRunAt({ nextEvaluationAt: null, evaluationLeaseUntil: null }, now).getTime()).toBe(
      now.getTime() + 5_000
    );
  });
});

describe("reconcileAlertJobs", () => {
  redisTest("creates missing jobs and never moves live ones", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const jobs = alertEvaluationJobs(worker);
    const missingAt = new Date(Date.now() + 60_000);
    const missing = await seed({ nextEvaluationAt: missingAt });
    const live = await seed();
    const liveAt = new Date(Date.now() + 600_000);
    await jobs.enqueue(live.id, liveAt);

    const result = await reconcileAlertJobs(
      { now: new Date() },
      { db, enqueueOnce: jobs.enqueueOnce }
    );

    expect(result).toEqual({ scanned: 2, enqueued: 1, complete: true });
    expect((await job(worker, missing.id))?.timestamp.getTime()).toBe(missingAt.getTime());
    expect((await job(worker, live.id))?.timestamp.getTime()).toBe(liveAt.getTime());
    await worker.stop();
  });

  redisTest("pages through every active alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alerts = [await seed(), await seed(), await seed()];

    const result = await reconcileAlertJobs(
      { now: new Date() },
      { db, enqueueOnce: alertEvaluationJobs(worker).enqueueOnce, pageSize: 1 }
    );

    expect(result).toEqual({ scanned: 3, enqueued: 3, complete: true });
    for (const alert of alerts) expect(await job(worker, alert.id)).not.toBeNull();
    await worker.stop();
  });

  redisTest("stops at the deadline without scanning", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await seed();
    const warnings: string[] = [];

    const result = await reconcileAlertJobs(
      { now: new Date() },
      {
        db,
        enqueueOnce: alertEvaluationJobs(worker).enqueueOnce,
        deadlineMs: 0,
        logger: { warn: (message) => warnings.push(message) },
      }
    );

    expect(result).toEqual({ scanned: 0, enqueued: 0, complete: false });
    expect(warnings).toEqual(["alerts.reconcile.deadline_reached"]);
    expect(await job(worker, alert.id)).toBeNull();
    await worker.stop();
  });

  redisTest("resumes from the cursor saved at the deadline", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const redis = new Redis({ ...redisOptions, keyPrefix: "alerts:engine:" });
    const cursorStore = redisReconcileCursorStore(redis);
    await cursorStore.set(null);
    await seed();
    await seed();
    await seed();
    const enqueueOnce = alertEvaluationJobs(worker).enqueueOnce;

    const first = await reconcileAlertJobs(
      { now: new Date() },
      {
        db,
        pageSize: 1,
        deadlineMs: 1_000,
        cursorStore,
        enqueueOnce: async (id, at) => {
          await new Promise((r) => setTimeout(r, 1_500));
          return enqueueOnce(id, at);
        },
      }
    );
    expect(first).toEqual({ scanned: 1, enqueued: 1, complete: false });
    expect(await cursorStore.get()).not.toBeNull();

    const second = await reconcileAlertJobs(
      { now: new Date() },
      { db, pageSize: 1, cursorStore, enqueueOnce }
    );
    expect(second).toEqual({ scanned: 2, enqueued: 2, complete: true });
    expect(await cursorStore.get()).toBeNull();

    const third = await reconcileAlertJobs(
      { now: new Date() },
      { db, pageSize: 1, cursorStore, enqueueOnce }
    );
    expect(third.scanned).toBe(3);
    await redis.quit();
    await worker.stop();
  });

  redisTest("boot enqueues one reconcile job across instances", async ({ redisOptions }) => {
    const first = createWorker(redisOptions);
    const second = createWorker(redisOptions);

    expect(await enqueueBootReconcile(first, new Date())).toBe(true);
    const before = await first.getJob(BOOT_RECONCILE_JOB_ID);
    expect(await enqueueBootReconcile(second, new Date(Date.now() + 1_000))).toBe(false);
    const after = await second.getJob(BOOT_RECONCILE_JOB_ID);

    expect(after?.deduplicationKey).toBe(before?.deduplicationKey);
    expect(after?.timestamp.getTime()).toBe(before?.timestamp.getTime());
    await first.stop();
    await second.stop();
  });
});
