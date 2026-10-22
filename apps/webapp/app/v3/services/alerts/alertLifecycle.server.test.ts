import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { getAlert } from "./storage/alertStore.server";
import type { PrismaClient } from "@trigger.dev/database";
import { rawSqlClient, startAlertsPostgres } from "../../../../test/helpers/alertTables";
import { redisTest } from "@internal/testcontainers";
import { alertEvaluationJobId, alertEvaluationJobs } from "./engine/evaluateAlertJob.server";
import { createWorker, depsFor } from "./alertLifecycleTestWorker";
import {
  activateAlertAndSchedule,
  createAlertAndSchedule,
  deleteAlertAndUnschedule,
  stopAlertAndUnschedule,
} from "./alertLifecycle.server";

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

describe("alert lifecycle wrapper", () => {
  redisTest("create schedules an evaluation job", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await createAlertAndSchedule(db, BASE, depsFor(worker));

    const job = await worker.getJob(alertEvaluationJobId(alert.id));
    expect(job).toBeTruthy();
    expect(job!.timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    await worker.stop();
  });

  redisTest("stop removes the evaluation job", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertAndSchedule(db, BASE, deps);
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();

    await stopAlertAndUnschedule(
      db,
      {
        id: alert.id,
        actorId: "user_1",
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
      },
      deps
    );

    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();
    await worker.stop();
  });

  redisTest("delete removes the evaluation job and the row", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertAndSchedule(db, BASE, deps);

    await deleteAlertAndUnschedule(
      db,
      { id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId },
      deps
    );

    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();
    expect(await getAlert(db, { id: alert.id })).toBeNull();
    await worker.stop();
  });

  redisTest("enqueue failure removes the alert and propagates", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const failure = new Error("redis down");
    const deps = {
      enqueue: async () => {
        throw failure;
      },
      ack: alertEvaluationJobs(worker).ack,
    };

    await expect(createAlertAndSchedule(db, { ...BASE, id: "alert_keep" }, deps)).rejects.toBe(
      failure
    );

    expect(await getAlert(db, { id: "alert_keep" })).toBeNull();
    await worker.stop();
  });

  redisTest(
    "enqueue failure after the alert was evaluated keeps it and its events",
    async ({ redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = {
        enqueue: async (alertId: string) => {
          await rawSql`INSERT INTO "AlertEvent" (id, "alertId", type, at, facts)
            VALUES ('evt_lost_reply', ${alertId}, 'raised', now(), '{}'::jsonb)`;
          throw new Error("reply lost");
        },
        ack: alertEvaluationJobs(worker).ack,
      };

      const alert = await createAlertAndSchedule(db, { ...BASE, id: "alert_evaluated" }, deps);

      expect(alert.id).toBe("alert_evaluated");
      expect(await getAlert(db, { id: "alert_evaluated" })).not.toBeNull();
      const events = await rawSql`SELECT id FROM "AlertEvent"
        WHERE "alertId" = 'alert_evaluated'`;
      expect(events).toHaveLength(1);
      await worker.stop();
    }
  );

  redisTest("delete with a wrong project keeps the row and the job", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertAndSchedule(db, BASE, deps);

    const result = await deleteAlertAndUnschedule(
      db,
      { id: alert.id, projectId: "other_proj", environmentId: BASE.environmentId },
      deps
    );

    expect(result).toBeNull();
    expect(await getAlert(db, { id: alert.id })).not.toBeNull();
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
    await worker.stop();
  });

  redisTest("ack failure is swallowed", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await createAlertAndSchedule(db, BASE, depsFor(worker));
    const deps = {
      enqueue: alertEvaluationJobs(worker).enqueue,
      ack: async () => {
        throw new Error("redis down");
      },
    };

    const result = await stopAlertAndUnschedule(
      db,
      {
        id: alert.id,
        actorId: "user_1",
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
      },
      deps
    );

    expect(result).not.toBeNull();
    expect((await getAlert(db, { id: alert.id }))!.lifecycle).toBe("stopped");
    await worker.stop();
  });

  redisTest("activate schedules an evaluation job", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertAndSchedule(db, BASE, deps);
    await stopAlertAndUnschedule(
      db,
      {
        id: alert.id,
        actorId: "user_1",
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
      },
      deps
    );
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();

    const result = await activateAlertAndSchedule(
      db,
      { id: alert.id, projectId: BASE.projectId, environmentId: BASE.environmentId },
      deps
    );

    expect(result).not.toBeNull();
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
    await worker.stop();
  });

  redisTest("activate with a wrong environment schedules nothing", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await createAlertAndSchedule(db, BASE, deps);
    await stopAlertAndUnschedule(
      db,
      {
        id: alert.id,
        actorId: "user_1",
        projectId: BASE.projectId,
        environmentId: BASE.environmentId,
      },
      deps
    );

    const result = await activateAlertAndSchedule(
      db,
      { id: alert.id, projectId: BASE.projectId, environmentId: "other_env" },
      deps
    );

    expect(result).toBeNull();
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();
    await worker.stop();
  });

  redisTest(
    "stop with a wrong project keeps the alert active and the job",
    async ({ redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const alert = await createAlertAndSchedule(db, BASE, deps);

      const result = await stopAlertAndUnschedule(
        db,
        {
          id: alert.id,
          actorId: "user_1",
          projectId: "other_proj",
          environmentId: BASE.environmentId,
        },
        deps
      );

      expect(result).toBeNull();
      expect((await getAlert(db, { id: alert.id }))!.lifecycle).toBe("active");
      expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
      await worker.stop();
    }
  );
});
