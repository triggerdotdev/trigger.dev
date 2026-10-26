import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });
import { redisTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { startAlertsPostgres } from "../../../../test/helpers/alertTables";
import {
  appendAlertEvent,
  createAlert,
  getAlert,
  listAlertEvents,
} from "./storage/alertStore.server";
import {
  activateAlert,
  AlertActionNotAllowedError,
  AlertActivationInvalidError,
  AlertNotFoundError,
  editAlert,
  performAlertAction,
} from "./alertActions.server";
import { createWorker, depsFor } from "./alertLifecycleTestWorker";
import { alertEvaluationJobId } from "./engine/evaluateAlertJob.server";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
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
  notifiers: [{ type: "channel" as const, channelId: "chan_1" }],
};

async function makeAlert(overrides: {
  lifecycle?: "active" | "completed" | "expired" | "stopped";
  attention?: "clear" | "needs_attention";
  environmentId?: string;
  expiresAt?: Date;
  notifiers?: typeof BASE.notifiers;
}) {
  return createAlert(db, { ...BASE, ...overrides });
}

describe("performAlertAction", () => {
  it("resolve clears attention and writes a resolved event with the actor", async () => {
    const alert = await makeAlert({ attention: "needs_attention" });

    await performAlertAction(db, {
      intent: "resolve",
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
      actorId: "user_2",
    });

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.attention).toBe("clear");
    expect(updated?.lifecycle).toBe("active");

    const events = await listAlertEvents(db, alert.id);
    const resolved = events.find((e) => e.type === "resolved");
    expect(resolved?.actorId).toBe("user_2");
  });

  it("resolve rejects an alert that isn't needs_attention", async () => {
    const alert = await makeAlert({ attention: "clear" });

    await expect(
      performAlertAction(db, {
        intent: "resolve",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertActionNotAllowedError);
  });

  redisTest(
    "stop sets lifecycle stopped and leaves attention unchanged",
    async ({ redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const alert = await makeAlert({
        lifecycle: "active",
        attention: "clear",
      });
      await deps.enqueue(alert.id, new Date());

      await performAlertAction(
        db,
        {
          intent: "stop",
          alertId: alert.id,
          projectId: alert.projectId,
          environmentId: alert.environmentId,
          actorId: "user_2",
        },
        deps
      );

      const updated = await getAlert(db, { id: alert.id });
      expect(updated?.lifecycle).toBe("stopped");
      expect(updated?.attention).toBe("clear");

      const events = await listAlertEvents(db, alert.id);
      expect(events.some((e) => e.type === "stopped" && e.actorId === "user_2")).toBe(true);
      expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();
      await worker.stop();
    }
  );

  it("stop rejects a non-active alert", async () => {
    const alert = await makeAlert({ lifecycle: "stopped" });

    await expect(
      performAlertAction(db, {
        intent: "stop",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertActionNotAllowedError);
  });

  it("stop rejects a needs_attention alert (REQ-003: only Resolve applies)", async () => {
    const alert = await makeAlert({
      lifecycle: "active",
      attention: "needs_attention",
    });

    await expect(
      performAlertAction(db, {
        intent: "stop",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertActionNotAllowedError);

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.lifecycle).toBe("active");
    expect(updated?.attention).toBe("needs_attention");
  });

  redisTest("delete removes the alert row and its events", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await makeAlert({ lifecycle: "stopped" });
    await deps.enqueue(alert.id, new Date());
    await appendAlertEvent(db, { alertId: alert.id, type: "stopped", facts: {} });

    await performAlertAction(
      db,
      {
        intent: "delete",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      },
      deps
    );

    expect(await getAlert(db, { id: alert.id })).toBeNull();
    expect(await listAlertEvents(db, alert.id)).toEqual([]);
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeNull();
    await worker.stop();
  });

  it("delete rejects an active alert", async () => {
    const alert = await makeAlert({ lifecycle: "active" });

    await expect(
      performAlertAction(db, {
        intent: "delete",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertActionNotAllowedError);
  });

  it("rejects an alert id from a different environment", async () => {
    const alert = await makeAlert({
      attention: "needs_attention",
      environmentId: "env_other",
    });

    await expect(
      performAlertAction(db, {
        intent: "resolve",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: "env_1",
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertNotFoundError);
  });

  it("resolves a race: two concurrent resolves produce exactly one resolved event", async () => {
    const alert = await makeAlert({ attention: "needs_attention" });

    const attempt = () =>
      performAlertAction(db, {
        intent: "resolve",
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      });

    const results = await Promise.allSettled([attempt(), attempt()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      AlertActionNotAllowedError
    );

    const events = await listAlertEvents(db, alert.id);
    expect(events.filter((e) => e.type === "resolved")).toHaveLength(1);
  });
});

describe("activateAlert", () => {
  redisTest("re-activates a stopped alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await makeAlert({ lifecycle: "stopped" });

    await activateAlert(
      db,
      {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      },
      deps
    );

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.lifecycle).toBe("active");
    expect(updated?.attention).toBe("clear");
    expect(updated?.observedCondition).toBe("unknown");
    expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
    await worker.stop();
  });

  redisTest("re-activates a completed alert", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await makeAlert({ lifecycle: "completed" });

    await activateAlert(
      db,
      {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      },
      depsFor(worker)
    );

    expect((await getAlert(db, { id: alert.id }))?.lifecycle).toBe("active");
    await worker.stop();
  });

  it("fails when activate is accepted for an active alert", async () => {
    const alert = await makeAlert({ lifecycle: "active" });

    await expect(
      activateAlert(db, {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertActionNotAllowedError);
  });

  redisTest("fails when evaluatorState survives activate", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const deps = depsFor(worker);
    const alert = await makeAlert({ lifecycle: "stopped" });

    await activateAlert(
      db,
      {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      },
      deps
    );

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.evaluatorState).toEqual({
      checkpoint: expect.any(String),
      activatedFloor: expect.any(String),
    });
    expect(updated?.pendingMetSince).toBeNull();
    expect(updated?.evaluationLeaseId).toBeNull();
    await worker.stop();
  });

  it("rejects a past expiry, stored or picked", async () => {
    const alert = await makeAlert({
      lifecycle: "expired",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const ids = {
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
      actorId: "user_2",
    };

    await expect(activateAlert(db, ids)).rejects.toThrow("Pick an expiry in the future");
    await expect(
      activateAlert(db, { ...ids, expiresAt: new Date(Date.now() - 1000) })
    ).rejects.toThrow(AlertActivationInvalidError);
    expect((await getAlert(db, { id: alert.id }))?.lifecycle).toBe("expired");
  });

  it("rejects activating without notifiers", async () => {
    const alert = await makeAlert({ lifecycle: "stopped", notifiers: [] });

    await expect(
      activateAlert(db, {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
      })
    ).rejects.toThrow("Add at least one notifier");
    expect((await getAlert(db, { id: alert.id }))?.lifecycle).toBe("stopped");
  });

  redisTest("accepts an expiry two years ahead", async ({ redisOptions }) => {
    const worker = createWorker(redisOptions);
    const alert = await makeAlert({ lifecycle: "stopped" });
    const expiresAt = new Date(Date.now() + 2 * 365 * 86_400_000);

    await activateAlert(
      db,
      {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: alert.environmentId,
        actorId: "user_2",
        expiresAt,
      },
      depsFor(worker)
    );

    expect((await getAlert(db, { id: alert.id }))?.expiresAt).toEqual(expiresAt);
    await worker.stop();
  });

  redisTest(
    "activates an expired alert with a new expiry and notifiers",
    async ({ redisOptions }) => {
      const worker = createWorker(redisOptions);
      const deps = depsFor(worker);
      const alert = await makeAlert({
        lifecycle: "expired",
        expiresAt: new Date(Date.now() - 60_000),
      });
      const expiresAt = new Date(Date.now() + 3_600_000);

      await activateAlert(
        db,
        {
          alertId: alert.id,
          projectId: alert.projectId,
          environmentId: alert.environmentId,
          actorId: "user_2",
          expiresAt,
          notifiers: [{ type: "channel", channelId: "chan_2" }],
        },
        deps
      );

      const updated = await getAlert(db, { id: alert.id });
      expect(updated?.lifecycle).toBe("active");
      expect(updated?.expiresAt).toEqual(expiresAt);
      expect(updated?.notifiers).toEqual([{ type: "channel", channelId: "chan_2" }]);
      expect(await worker.getJob(alertEvaluationJobId(alert.id))).toBeTruthy();
      await worker.stop();
    }
  );

  it("fails when a non-owner env can activate", async () => {
    const alert = await makeAlert({
      lifecycle: "stopped",
      environmentId: "env_other_activate",
    });

    await expect(
      activateAlert(db, {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: "env_1",
        actorId: "user_2",
      })
    ).rejects.toThrow(AlertNotFoundError);
  });
});

describe("editAlert", () => {
  it("fails when edit changes the condition", async () => {
    const alert = await makeAlert({ lifecycle: "active" });

    await editAlert(db, {
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
      notifiers: [{ type: "channel", channelId: "chan_2" }],
    });

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.condition).toEqual(BASE.condition);
  });

  it("persists a new expiry and keeps notifiers", async () => {
    const alert = await makeAlert({ lifecycle: "active" });
    const expiresAt = new Date(Date.now() + 3_600_000);

    await editAlert(db, {
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
      expiresAt,
    });

    const updated = await getAlert(db, { id: alert.id });
    expect(updated?.expiresAt).toEqual(expiresAt);
    expect(updated?.notifiers).toEqual(BASE.notifiers);
    expect(updated?.lifecycle).toBe("active");
  });

  it("clears the expiry with null and leaves it alone when omitted", async () => {
    const alert = await makeAlert({
      lifecycle: "active",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const ids = {
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
    };

    await editAlert(db, { ...ids, notifiers: [{ type: "channel", channelId: "chan_2" }] });
    expect((await getAlert(db, { id: alert.id }))?.expiresAt).toEqual(alert.expiresAt);

    await editAlert(db, { ...ids, expiresAt: null });
    expect((await getAlert(db, { id: alert.id }))?.expiresAt).toBeNull();
  });

  it("fails when a non-owner env can edit", async () => {
    const alert = await makeAlert({
      lifecycle: "active",
      environmentId: "env_other_edit",
    });

    await expect(
      editAlert(db, {
        alertId: alert.id,
        projectId: alert.projectId,
        environmentId: "env_1",
        notifiers: [{ type: "channel", channelId: "chan_2" }],
      })
    ).rejects.toThrow(AlertNotFoundError);
  });

  it("fails when editing an alert with a chat notifier rewrites it as a channel", async () => {
    const alert = await makeAlert({ lifecycle: "active" });

    const chatRef = { type: "chat" as const, conversationId: "project", userId: "user_1" };
    const channelRef = { type: "channel" as const, channelId: "chan_1" };

    await editAlert(db, {
      alertId: alert.id,
      projectId: alert.projectId,
      environmentId: alert.environmentId,
      notifiers: [chatRef, channelRef],
    });

    const updated = await getAlert(db, { id: alert.id });
    const notifiers = updated?.notifiers as Array<{ type: string }>;
    const chat = notifiers.find((n) => n.type === "chat");
    expect(chat).toBeDefined();
    expect(chat).toEqual(chatRef);
    const channel = notifiers.find((n) => n.type === "channel");
    expect(channel).toEqual(channelRef);
  });
});
