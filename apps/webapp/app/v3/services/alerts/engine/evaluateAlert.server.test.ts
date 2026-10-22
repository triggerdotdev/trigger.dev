import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import {
  createAlert,
  claimAlertsForEvaluation,
  listAlertEvents,
  expireAlerts,
  EXPIRE_ALERTS_BATCH,
  stopAlert,
  resolveAlert,
  getAlert,
  listPendingDeliveriesForEvent,
  applyEvaluationOutcome,
} from "../storage/alertStore.server";
import type { PrismaClient } from "@trigger.dev/database";
import { rawSqlClient, startAlertsPostgres } from "../../../../../test/helpers/alertTables";
import {
  evaluateAlert,
  queryResultToBindingResult,
  applyCompositeHysteresis,
  type EvaluateBindingFn,
  type CompositeHysteresisState,
} from "./evaluateAlert.server";
import { createProductionEvaluateBinding } from "./productionEvaluateBinding.server";
import { alertPhaseOffsetMs } from "./alertSchedule";
import { runAlertsHousekeeping, type AlertsHousekeepingDeps } from "./alertsTick.server";
import type { EvaluationResult } from "@internal/alert-contracts";

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;
let rawSql: ReturnType<typeof rawSqlClient>;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
  rawSql = rawSqlClient(db);
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
  notifiers: [
    { type: "channel", channelId: "chan_1" },
    { type: "channel", channelId: "chan_2" },
  ],
};

async function claimOne(now: Date) {
  const claimed = await claimAlertsForEvaluation(db, {
    now,
    leaseMs: 120_000,
    limit: 1,
  });
  return claimed[0]!;
}

function metResult(facts: Record<string, unknown> = { value: 150 }): EvaluationResult {
  return { kind: "stateful", outcome: "met", facts };
}

function notMetResult(): EvaluationResult {
  return { kind: "stateful", outcome: "not_met", facts: { value: 50 } };
}

function unavailableResult(): EvaluationResult {
  return { kind: "stateful", outcome: "unavailable", facts: {} };
}

const DAY_MS = 86_400_000;

function occ(
  sourceEventId: string,
  rowTime: Date,
  expiresAt = new Date(rowTime.getTime() + DAY_MS)
) {
  return { sourceEventId, rowTime, expiresAt, facts: { key: sourceEventId } };
}

function occurrenceResult(
  occurrences: Array<{
    sourceEventId: string;
    rowTime: Date;
    expiresAt: Date;
    facts: Record<string, unknown>;
  }>
): EvaluationResult {
  return {
    kind: "occurrence",
    outcome: occurrences.length > 0 ? "met" : "not_met",
    occurrences,
    facts: {},
  };
}

function bindingFor(
  result: EvaluationResult,
  statePatch?: Record<string, unknown>
): EvaluateBindingFn {
  return async () => ({ result, evaluatorStatePatch: statePatch });
}

async function resetAlerts() {
  await rawSql`DELETE FROM "AlertOccurrenceSeen"`;
  await rawSql`DELETE FROM "AlertDelivery"`;
  await rawSql`DELETE FROM "AlertEvent"`;
  await rawSql`DELETE FROM "Alert"`;
}

beforeEach(async () => {
  await resetAlerts();
});

describe("evaluateAlert", () => {
  it("full raise path: writes alert patch + raised event + N pending deliveries and calls enqueue", async () => {
    await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);

    const enqueueCalls: Array<{ eventId: string; eventAt: Date }> = [];
    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(metResult()),
      enqueueDelivery: async (params) => {
        enqueueCalls.push(params);
      },
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("raised");
    expect(outcome.deliveryCount).toBe(2);
    expect(enqueueCalls).toHaveLength(1);

    const events = await listAlertEvents(db, claimed.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("raised");
    expect(events[0]!.facts).toEqual({ value: 150 });
    expect(enqueueCalls[0]).toEqual({ eventId: events[0]!.id, eventAt: events[0]!.at });

    const deliveries = await listPendingDeliveriesForEvent(db, events[0]!.id, events[0]!.at);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === "pending")).toBe(true);
  });

  it("stateful met->met writes nothing (no duplicate raise)", async () => {
    await createAlert(db, { ...BASE, attention: "needs_attention", observedCondition: "met" });
    const now = new Date();
    const claimed = await claimOne(now);

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(metResult()),
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toHaveLength(0);
    expect(outcome.deliveryCount).toBe(0);
  });

  it("resolve while still met re-raises on the next evaluation (mutation: prevObs guard on raise -> no second raise)", async () => {
    await createAlert(db, BASE);
    const enqueueCalls: Array<{ eventId: string; eventAt: Date }> = [];
    const deps = {
      db,
      evaluateBinding: bindingFor(metResult()),
      enqueueDelivery: async (params: { eventId: string; eventAt: Date }) => {
        enqueueCalls.push(params);
      },
    };

    const first = await evaluateAlert(await claimOne(new Date()), deps);
    expect(first.events).toEqual(["raised"]);

    const alertId = first.alert!.id;
    await resolveAlert(db, { id: alertId, actorId: "user_1" });
    expect((await getAlert(db, { id: alertId }))!.observedCondition).toBe("met");

    const later = new Date(Date.now() + DAY_MS);
    const second = await evaluateAlert(await claimOne(later), deps);
    expect(second.events).toEqual(["raised"]);
    expect(second.deliveryCount).toBe(2);
    expect(second.alert!.attention).toBe("needs_attention");

    const types = (await listAlertEvents(db, alertId)).map((e) => e.type).sort();
    expect(types).toEqual(["raised", "raised", "resolved"]);
    expect(enqueueCalls).toHaveLength(2);

    const third = await evaluateAlert(await claimOne(new Date(later.getTime() + DAY_MS)), deps);
    expect(third.events).toEqual([]);
    expect(enqueueCalls).toHaveLength(2);
  });

  it("raise after recovery without resolve records raised but delivers nothing (mutation: deliver on every raised -> extra deliveries)", async () => {
    await createAlert(db, BASE);
    const enqueueCalls: Array<{ eventId: string; eventAt: Date }> = [];
    let result = metResult();
    const deps = {
      db,
      evaluateBinding: async () => ({ result }),
      enqueueDelivery: async (params: { eventId: string; eventAt: Date }) => {
        enqueueCalls.push(params);
      },
    };
    let at = Date.now();
    const tick = async (next: EvaluationResult) => {
      result = next;
      at += DAY_MS;
      return evaluateAlert(await claimOne(new Date(at)), deps);
    };

    const first = await tick(metResult());
    expect(first.deliveryCount).toBe(2);
    expect((await tick(notMetResult())).events).toEqual(["recovered"]);

    const second = await tick(metResult());
    expect(second.events).toEqual(["raised"]);
    expect(second.deliveryCount).toBe(0);
    expect(enqueueCalls).toHaveLength(1);

    const alertId = first.alert!.id;
    expect((await tick(notMetResult())).events).toEqual(["recovered"]);
    await resolveAlert(db, { id: alertId, actorId: "user_1" });

    const third = await tick(metResult());
    expect(third.events).toEqual(["raised"]);
    expect(third.deliveryCount).toBe(2);
    expect(enqueueCalls).toHaveLength(2);

    const events = await listAlertEvents(db, alertId);
    expect(events.filter((e) => e.type === "raised")).toHaveLength(3);
    const silent = events.find(
      (e) =>
        e.id !== enqueueCalls[0]!.eventId &&
        e.id !== enqueueCalls[1]!.eventId &&
        e.type === "raised"
    )!;
    expect(await listPendingDeliveriesForEvent(db, silent.id, silent.at)).toHaveLength(0);
  });

  it("recovery writes recovered and keeps attention", async () => {
    await createAlert(db, {
      ...BASE,
      attention: "needs_attention",
      observedCondition: "met",
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(notMetResult()),
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("recovered");

    const rows =
      await rawSql`SELECT attention, "observedCondition" AS observed_condition FROM "Alert" WHERE id = ${claimed.id}`;
    expect(rows[0]!.attention).toBe("needs_attention");
    expect(rows[0]!.observed_condition).toBe("not_met");
  });

  it("occurrence: first raise binds to newest row, replay of seen keys writes nothing", async () => {
    await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);

    const result = occurrenceResult([
      occ("fp:task:new:2000", new Date(now.getTime() - 60_000)),
      occ("fp:task:new:1000", new Date(now.getTime() - 120_000)),
    ]);

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(result),
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toEqual(["raised"]);
    const events = await listAlertEvents(db, claimed.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.sourceEventId).toBe("fp:task:new:2000");

    const replayClaimed = await claimOne(new Date(now.getTime() + 301_000));
    const replayOutcome = await evaluateAlert(replayClaimed, {
      db,
      evaluateBinding: bindingFor(result),
      enqueueDelivery: async () => {},
    });

    expect(replayOutcome.applied).toBe(true);
    expect(replayOutcome.events).toEqual([]);
    expect(await listAlertEvents(db, claimed.id)).toHaveLength(1);
  });

  it("stale lease -> nothing applied", async () => {
    await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);

    await rawSql`UPDATE "Alert" SET "evaluationLeaseId" = 'stale_lease' WHERE id = ${claimed.id}`;

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(metResult()),
    });

    expect(outcome.applied).toBe(false);
  });

  it("binding error releases the lease and schedules next evaluation (mutation: remove try/catch -> throws instead of releasing)", async () => {
    const now = new Date();
    await createAlert(db, { ...BASE, pendingMetSince: now });
    const claimed = await claimOne(now);

    const throwingBinding: EvaluateBindingFn = async () => {
      throw new Error("ClickHouse unavailable");
    };

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: throwingBinding,
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toHaveLength(0);

    const rows =
      await rawSql`SELECT "evaluationLeaseId" AS evaluation_lease_id, "lastEvaluatedAt" AS last_evaluated_at, "nextEvaluationAt" AS next_evaluation_at, "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${claimed.id}`;
    expect(rows[0]!.evaluation_lease_id).toBeNull();
    expect(rows[0]!.last_evaluated_at).not.toBeNull();
    expect(rows[0]!.next_evaluation_at).not.toBeNull();
    const state = rows[0]!.evaluator_state as Record<string, unknown>;
    expect(state.lastError).toBeDefined();
    expect((state.lastError as any).reason).toContain("ClickHouse unavailable");
    expect((await getAlert(db, { id: claimed.id }))!.pendingMetSince).toBeNull();
  });

  it("binding error breaks a pending hold (mutation: drop pendingMetSince: null -> raises after the blind gap)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const created = await createAlert(db, {
        ...BASE,
        condition: { ...BASE.condition, holdSec: 300 },
      });
      const t0 = new Date();
      const enqueue = vi.fn(async () => {});

      vi.setSystemTime(t0);
      const first = await evaluateAlert(await claimOne(new Date(t0.getTime() + 1_000_000)), {
        db,
        evaluateBinding: bindingFor(metResult()),
        enqueueDelivery: enqueue,
      });
      expect(first.events).toEqual([]);
      expect((await getAlert(db, { id: created.id }))!.pendingMetSince).not.toBeNull();

      const t1 = new Date(t0.getTime() + 60_000);
      vi.setSystemTime(t1);
      const failed = await evaluateAlert(await claimOne(new Date(t0.getTime() + 2_000_000)), {
        db,
        evaluateBinding: async () => {
          throw new Error("ClickHouse unavailable");
        },
      });
      expect(failed.bindingFailed).toBe(true);

      const t2 = new Date(t0.getTime() + 400_000);
      vi.setSystemTime(t2);
      const third = await evaluateAlert(await claimOne(new Date(t0.getTime() + 3_000_000)), {
        db,
        evaluateBinding: bindingFor(metResult()),
        enqueueDelivery: enqueue,
      });

      expect(third.events).toEqual([]);
      expect(third.deliveryCount).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
      const after = await getAlert(db, { id: created.id });
      expect(after!.pendingMetSince!.getTime()).toBe(t2.getTime());
      expect(await listAlertEvents(db, created.id)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binding error with a lost lease reports not applied (mutation: applied: true)", async () => {
    await createAlert(db, BASE);
    const claimed = await claimOne(new Date());

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: async () => {
        await rawSql`UPDATE "Alert" SET "evaluationLeaseId" = 'stale_lease' WHERE id = ${claimed.id}`;
        throw new Error("ClickHouse unavailable");
      },
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.bindingFailed).toBe(true);
    const rows =
      await rawSql`SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${claimed.id}`;
    expect((rows[0]!.evaluator_state as Record<string, unknown> | null)?.lastError).toBeUndefined();
  });

  it("successful evaluation after error clears lastError (mutation: remove lastError:null -> stale error persists)", async () => {
    await createAlert(db, BASE);
    const now = new Date();

    const claimed1 = await claimOne(now);
    await evaluateAlert(claimed1, {
      db,
      evaluateBinding: async () => {
        throw new Error("transient failure");
      },
    });

    const afterError =
      await rawSql`SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${claimed1.id}`;
    expect((afterError[0]!.evaluator_state as any).lastError).toBeDefined();

    const now2 = new Date(now.getTime() + 301_000);
    const claimed2 = await claimOne(now2);
    await evaluateAlert(claimed2, {
      db,
      evaluateBinding: bindingFor(notMetResult()),
    });

    const afterSuccess =
      await rawSql`SELECT "evaluatorState" AS evaluator_state FROM "Alert" WHERE id = ${claimed1.id}`;
    expect((afterSuccess[0]!.evaluator_state as any).lastError).toBeNull();
  });

  it("expiry clears attention", async () => {
    const past = new Date(Date.now() - 60_000);
    await createAlert(db, {
      ...BASE,
      attention: "needs_attention",
      observedCondition: "met",
      expiresAt: past,
    });

    const expired = await expireAlerts(db, new Date(), { limit: EXPIRE_ALERTS_BATCH });
    expect(expired).toHaveLength(1);
    expect(expired[0]!.alert.attention).toBe("clear");
    expect(expired[0]!.alert.lifecycle).toBe("expired");
  });

  it("query-bound threshold alert raises via queryResultToBindingResult bridge (mutation: remove dispatch -> test fails)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "queue.depth",
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const fakeQueryBinding: EvaluateBindingFn = async (_alert, capability) => {
      if (capability.binding.type !== "query") throw new Error("expected query binding");
      return queryResultToBindingResult({
        status: "met",
        facts: {
          value: 200,
          unit: "count",
          threshold: 100,
          windowSec: 300,
          bucketSec: 300,
          observedAt: now.toISOString(),
        },
      });
    };

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: fakeQueryBinding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("raised");
    expect(outcome.deliveryCount).toBe(2);
  });
});

describe("occurrence delivery", () => {
  const occurrences = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sourceEventId: `${prefix}:${i}`,
      rowTime: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      facts: { fingerprint: `${prefix}${i}` },
    }));

  async function raisedAlert(capabilityKey: string) {
    await createAlert(db, {
      ...BASE,
      capabilityKey,
      condition: { kind: "occurrence" },
      notifiers: [{ type: "channel", channelId: "chan_1" }],
    });
    const now = new Date();
    const first = await claimOne(now);
    await evaluateAlert(first, {
      db,
      evaluateBinding: bindingFor(occurrenceResult(occurrences("first", 1))),
      enqueueDelivery: async () => {},
    });
    return claimOne(new Date(now.getTime() + 301_000));
  }

  async function evaluateMatches(claimed: Awaited<ReturnType<typeof claimOne>>, n: number) {
    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(occurrenceResult(occurrences("next", n))),
      enqueueDelivery: async () => {},
    });
    return { outcome };
  }

  it("occurrence alerts never emit recovered", async () => {
    const claimed = await raisedAlert("errors.new");
    const { outcome } = await evaluateMatches(claimed, 0);

    expect(outcome.events).toEqual([]);
    const events = await listAlertEvents(db, claimed.id);
    expect(events.map((e) => e.type)).not.toContain("recovered");
  });
});

describe("runAlertsHousekeeping", () => {
  it("sweeper re-enqueues stale pending deliveries (threshold 2 min)", async () => {
    const alert = await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(metResult()),
      enqueueDelivery: async () => {},
    });

    const events = await listAlertEvents(db, alert.id);
    const deliveries = await listPendingDeliveriesForEvent(db, events[0]!.id, events[0]!.at);

    await rawSql`UPDATE "AlertDelivery" SET "createdAt" = now() - interval '3 minutes' WHERE id = ${deliveries[0]!.id}`;

    const enqueueCalls: Array<{ eventId: string; eventAt: Date }> = [];
    const sweepNow = new Date();
    const deps: AlertsHousekeepingDeps = {
      db,
      enqueueDelivery: async (params) => {
        enqueueCalls.push(params);
      },
    };

    const result = await runAlertsHousekeeping({ now: sweepNow }, deps);
    expect(result.sweeperRequeues).toBeGreaterThanOrEqual(1);
    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1);
    expect(enqueueCalls[0]).toEqual({ eventId: events[0]!.id, eventAt: events[0]!.at });
  });

  it("sweeper re-enqueues stale delivering rows (crash after claim)", async () => {
    const alert = await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(metResult()),
      enqueueDelivery: async () => {},
    });

    const events = await listAlertEvents(db, alert.id);
    const deliveries = await listPendingDeliveriesForEvent(db, events[0]!.id, events[0]!.at);

    await rawSql`UPDATE "AlertDelivery" SET status = 'delivering', "claimId" = 'crashed-claim', "claimedAt" = now() - interval '6 minutes' WHERE id = ${deliveries[0]!.id}`;

    const enqueueCalls: Array<{ eventId: string; eventAt: Date }> = [];
    const sweepNow = new Date();
    const deps: AlertsHousekeepingDeps = {
      db,
      enqueueDelivery: async (params) => {
        enqueueCalls.push(params);
      },
    };

    const result = await runAlertsHousekeeping({ now: sweepNow }, deps);
    expect(result.sweeperRequeues).toBeGreaterThanOrEqual(1);
    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1);
    expect(enqueueCalls[0]).toEqual({ eventId: events[0]!.id, eventAt: events[0]!.at });
  });

  it("does not evaluate: alert row unchanged, no enqueue (mutation: evaluation left in -> row changes)", async () => {
    await createAlert(db, BASE);
    const before = await rawSql`SELECT * FROM "Alert"`;

    const enqueueCalls: string[] = [];
    await runAlertsHousekeeping(
      { now: new Date(Date.now() + 3_600_000) },
      {
        db,
        enqueueDelivery: async ({ eventId }) => {
          enqueueCalls.push(eventId);
        },
      }
    );

    const after = await rawSql`SELECT * FROM "Alert"`;
    expect(after).toEqual(before);
    expect(enqueueCalls).toEqual([]);
  });

  it("expires an active alert past expiresAt and writes the expired event", async () => {
    const alert = await createAlert(db, { ...BASE, expiresAt: new Date(Date.now() - 60_000) });

    const result = await runAlertsHousekeeping({ now: new Date() }, { db });
    expect(result.expired).toBe(1);

    const alerts = await rawSql`SELECT lifecycle FROM "Alert" WHERE id = ${alert.id}`;
    expect(alerts[0]!.lifecycle).toBe("expired");
    const events =
      await rawSql`SELECT 1 FROM "AlertEvent" WHERE "alertId" = ${alert.id} AND type = 'expired'`;
    expect(events.length).toBe(1);
  });
});

describe("production dispatcher bridge", () => {
  beforeEach(async () => {
    await resetAlerts();
  });

  it("query-bound alert raises through queryResultToBindingResult with a faked query result", async () => {
    await createAlert(db, {
      ...BASE,
      params: { environmentId: "env_1", scope: { type: "queue", queue: "q1" } },
      condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
    });
    const now = new Date();
    const claimed = await claimOne(now);

    const fakeBinding: EvaluateBindingFn = async (_alert, capability) => {
      if (capability.binding.type !== "query") throw new Error("expected query binding");
      return queryResultToBindingResult({
        status: "met",
        facts: { value: 200, unit: "count", threshold: 100 },
      });
    };

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: fakeBinding,
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(true);
    expect(outcome.events).toContain("raised");
    expect(outcome.deliveryCount).toBe(2);
  });
});

describe("lease fence vs user actions", () => {
  it("stop invalidates lease: stale evaluator's applyEvaluationOutcome fails, lifecycle stays stopped", async () => {
    await createAlert(db, BASE);
    const now = new Date();
    const claimed = await claimOne(now);
    const leaseId = claimed.evaluationLeaseId;

    await stopAlert(db, {
      id: claimed.id,
      projectId: claimed.projectId,
      environmentId: claimed.environmentId,
      actorId: "user_1",
    });

    const outcome = await applyEvaluationOutcome(db, {
      alertId: claimed.id,
      leaseId,
      patch: { attention: "needs_attention", observedCondition: "met" },
      events: [{ type: "raised", facts: { value: 150 } }],
      deliveries: [{ alertEventIndex: 0, notifier: { type: "channel", channelId: "chan_1" } }],
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.events).toHaveLength(0);
    expect(outcome.deliveries).toHaveLength(0);

    const alert = await getAlert(db, { id: claimed.id });
    expect(alert!.lifecycle).toBe("stopped");
  });

  it("resolve invalidates lease: stale evaluator's write fails, attention stays clear", async () => {
    await createAlert(db, {
      ...BASE,
      attention: "needs_attention",
      observedCondition: "met",
    });
    const now = new Date();
    const claimed = await claimOne(now);
    const leaseId = claimed.evaluationLeaseId;

    await resolveAlert(db, { id: claimed.id, actorId: "user_1" });

    const outcome = await applyEvaluationOutcome(db, {
      alertId: claimed.id,
      leaseId,
      patch: { attention: "needs_attention", observedCondition: "met" },
      events: [{ type: "raised", facts: {} }],
      deliveries: [],
    });

    expect(outcome.applied).toBe(false);
    const alert = await getAlert(db, { id: claimed.id });
    expect(alert!.attention).toBe("clear");
  });

  it("expire invalidates lease: stale evaluator's write fails", async () => {
    const past = new Date(Date.now() - 60_000);
    await createAlert(db, { ...BASE, expiresAt: past });
    const now = new Date(Date.now() - 120_000);
    const claimed = await claimOne(now);
    const leaseId = claimed.evaluationLeaseId;

    await expireAlerts(db, new Date(), { limit: EXPIRE_ALERTS_BATCH });

    const outcome = await applyEvaluationOutcome(db, {
      alertId: claimed.id,
      leaseId,
      patch: { attention: "needs_attention", observedCondition: "met" },
      events: [{ type: "raised", facts: {} }],
      deliveries: [],
    });

    expect(outcome.applied).toBe(false);
    const alert = await getAlert(db, { id: claimed.id });
    expect(alert!.lifecycle).toBe("expired");
  });
});

describe("applyCompositeHysteresis", () => {
  it("2-consecutive met raises, 2-consecutive not_met recovers", () => {
    let state: CompositeHysteresisState = { consecutiveMet: 0, consecutiveNotMet: 0 };

    let r = applyCompositeHysteresis(state, "met");
    expect(r.effective).toBe("unchanged");
    state = r.state;

    r = applyCompositeHysteresis(state, "met");
    expect(r.effective).toBe("met");
    state = r.state;

    r = applyCompositeHysteresis(state, "not_met");
    expect(r.effective).toBe("unchanged");
    state = r.state;

    r = applyCompositeHysteresis(state, "not_met");
    expect(r.effective).toBe("not_met");
  });

  it("3rd consecutive met is still 'met' (>= 2, not === 2)", () => {
    let state: CompositeHysteresisState = { consecutiveMet: 0, consecutiveNotMet: 0 };
    let r = applyCompositeHysteresis(state, "met");
    state = r.state;
    r = applyCompositeHysteresis(state, "met");
    expect(r.effective).toBe("met");
    state = r.state;
    r = applyCompositeHysteresis(state, "met");
    expect(r.effective).toBe("met");
    expect(r.state.consecutiveMet).toBe(3);
  });

  it("unavailable resets both counters", () => {
    const state: CompositeHysteresisState = { consecutiveMet: 1, consecutiveNotMet: 0 };
    const r = applyCompositeHysteresis(state, "unavailable");
    expect(r.effective).toBe("unchanged");
    expect(r.state.consecutiveMet).toBe(0);
    expect(r.state.consecutiveNotMet).toBe(0);
  });
});

describe("composite hysteresis integration", () => {
  it("composite met once does NOT raise, twice raises (mutation: 1-consecutive -> premature raise)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "degraded" },
      evaluatorState: { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 0 } },
    });

    const now1 = new Date();
    const claimed1 = await claimOne(now1);
    const r1 = await evaluateAlert(claimed1, {
      db,
      evaluateBinding: bindingFor(metResult({ components: { flow: { outcome: "met" } } })),
      enqueueDelivery: async () => {},
    });

    expect(r1.applied).toBe(true);
    expect(r1.events).toHaveLength(0);

    const now2 = new Date(now1.getTime() + 301_000);
    const claimed2 = await claimOne(now2);
    const r2 = await evaluateAlert(claimed2, {
      db,
      evaluateBinding: bindingFor(metResult({ components: { flow: { outcome: "met" } } })),
      enqueueDelivery: async () => {},
    });

    expect(r2.applied).toBe(true);
    expect(r2.events).toContain("raised");
  });

  it("unavailable resets counters (mutation: unavailable does not reset counters)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "degraded" },
      evaluatorState: { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 0 } },
    });

    const now1 = new Date();
    const claimed1 = await claimOne(now1);
    await evaluateAlert(claimed1, {
      db,
      evaluateBinding: bindingFor(metResult({ components: { flow: { outcome: "met" } } })),
      enqueueDelivery: async () => {},
    });

    const now2 = new Date(now1.getTime() + 301_000);
    const claimed2 = await claimOne(now2);
    await evaluateAlert(claimed2, {
      db,
      evaluateBinding: bindingFor(unavailableResult()),
      enqueueDelivery: async () => {},
    });

    const now3 = new Date(now2.getTime() + 301_000);
    const claimed3 = await claimOne(now3);
    const r3 = await evaluateAlert(claimed3, {
      db,
      evaluateBinding: bindingFor(metResult({ components: { flow: { outcome: "met" } } })),
      enqueueDelivery: async () => {},
    });

    expect(r3.applied).toBe(true);
    expect(r3.events).not.toContain("raised");
  });

  it("thrown binding resets counters (mutation: catch does not reset compositeHysteresis)", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "degraded" },
      evaluatorState: { compositeHysteresis: { consecutiveMet: 0, consecutiveNotMet: 0 } },
    });

    const met = bindingFor(metResult({ components: { flow: { outcome: "met" } } }));
    const throwing: EvaluateBindingFn = async () => {
      throw new Error("ClickHouse unavailable");
    };

    const now1 = new Date();
    await evaluateAlert(await claimOne(now1), {
      db,
      evaluateBinding: met,
      enqueueDelivery: async () => {},
    });

    const now2 = new Date(now1.getTime() + 301_000);
    await evaluateAlert(await claimOne(now2), {
      db,
      evaluateBinding: throwing,
      enqueueDelivery: async () => {},
    });

    const now3 = new Date(now2.getTime() + 301_000);
    const claimed3 = await claimOne(now3);
    const r3 = await evaluateAlert(claimed3, {
      db,
      evaluateBinding: met,
      enqueueDelivery: async () => {},
    });

    expect(r3.applied).toBe(true);
    expect(r3.events).not.toContain("raised");
    const alert = await getAlert(db, { id: claimed3.id });
    const state = alert!.evaluatorState as { compositeHysteresis: { consecutiveMet: number } };
    expect(state.compositeHysteresis.consecutiveMet).toBe(1);
  });
});

describe("composite evaluatorState snapshot", () => {
  it("fails when evaluatorState.lastComponents is not updated on a not_met tick", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      condition: { kind: "state", stateKey: "degraded" },
    });

    const now1 = new Date();
    const claimed1 = await claimOne(now1);
    const notMetFacts = {
      components: {
        flow: { outcome: "not_met", effectiveParams: { schedulingDelayMs: 30000 } },
        execution: { outcome: "not_met", effectiveParams: { failureRatePct: 10 } },
        liveness: { outcome: "not_met", effectiveParams: { silenceSec: 300 } },
      },
    };

    await evaluateAlert(claimed1, {
      db,
      evaluateBinding: bindingFor({ kind: "stateful", outcome: "not_met", facts: notMetFacts }),
      enqueueDelivery: async () => {},
    });

    const alert = await getAlert(db, { id: claimed1.id });
    const state = alert!.evaluatorState as Record<string, unknown>;
    expect(state.lastComponents).toEqual(notMetFacts.components);
    expect(state.lastEffectiveParams).toEqual({
      schedulingDelayMs: 30000,
      failureRatePct: 10,
      silenceSec: 300,
    });
    expect(typeof state.observedAt).toBe("string");
  });
});

describe("unavailable reason tracking", () => {
  it("fails when an unavailable outcome leaves lastError null (stale_beyond_horizon)", async () => {
    await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor({
        kind: "stateful",
        outcome: "unavailable",
        facts: { unavailableReason: "stale_beyond_horizon" },
      }),
      enqueueDelivery: async () => {},
    });

    const alert = await getAlert(db, { id: claimed.id });
    const state = alert!.evaluatorState as Record<string, unknown>;
    expect(state.lastError).not.toBeNull();
    const err = state.lastError as { reason: string; at: string };
    expect(err.reason).toBe("stale_beyond_horizon");
    expect(typeof err.at).toBe("string");
  });

  it("fails when an unavailable outcome leaves lastError null (empty_result)", async () => {
    await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor({
        kind: "stateful",
        outcome: "unavailable",
        facts: { unavailableReason: "empty_result" },
      }),
      enqueueDelivery: async () => {},
    });

    const alert = await getAlert(db, { id: claimed.id });
    const state = alert!.evaluatorState as Record<string, unknown>;
    expect(state.lastError).not.toBeNull();
    expect((state.lastError as { reason: string }).reason).toBe("empty_result");
  });

  it("lane rejection retries in 30-60s without advancing lastEvaluatedAt or touching state/events", async () => {
    await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);
    await rawSql`UPDATE "Alert" SET "evaluatorState" = ${JSON.stringify({ keep: 1 })}::jsonb WHERE id = ${claimed.id}`;
    const before = (await getAlert(db, { id: claimed.id }))!;

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: async () => {
        throw Object.assign(new Error("rejected"), { __queryConcurrencyRejection: true });
      },
      enqueueDelivery: async () => {},
    });

    expect(outcome.laneRejected).toBe(true);
    const after = (await getAlert(db, { id: claimed.id }))!;
    const t = after.nextEvaluationAt!.getTime();
    expect(t).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(after.lastEvaluatedAt).toEqual(before.lastEvaluatedAt);
    expect(after.evaluatorState).toEqual(before.evaluatorState);
    expect(after.evaluationLeaseId).toBeNull();
    expect(await listAlertEvents(db, claimed.id)).toHaveLength(0);
  });

  it("composite lane rejection retries in 30-60s without advancing lastEvaluatedAt or touching state/events", async () => {
    await createAlert(db, {
      ...BASE,
      capabilityKey: "health.all",
      params: { environmentId: "env_pd", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "degraded" },
    });
    const now = new Date();
    const claimed = await claimOne(now);
    await rawSql`UPDATE "Alert" SET "evaluatorState" = ${JSON.stringify({ keep: 1 })}::jsonb WHERE id = ${claimed.id}`;
    const before = (await getAlert(db, { id: claimed.id }))!;

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: createProductionEvaluateBinding({
        queryRowRunner: async () => {
          throw Object.assign(new Error("rejected"), { __queryConcurrencyRejection: true });
        },
      }),
      enqueueDelivery: async () => {},
    });

    expect(outcome.laneRejected).toBe(true);
    const after = (await getAlert(db, { id: claimed.id }))!;
    const t = after.nextEvaluationAt!.getTime();
    expect(t).toBeGreaterThanOrEqual(now.getTime() + 30_000);
    expect(t).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(after.lastEvaluatedAt).toEqual(before.lastEvaluatedAt);
    expect(after.evaluatorState).toEqual(before.evaluatorState);
    expect(after.evaluationLeaseId).toBeNull();
    expect(await listAlertEvents(db, claimed.id)).toHaveLength(0);
  });

  it("unknown capability releases the lease and schedules the next grid slot", async () => {
    const alert = await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);
    await rawSql`UPDATE "Alert" SET "capabilityKey" = 'nope.nope', "nextEvaluationAt" = ${now.toISOString()}::timestamptz WHERE id = ${alert.id}`;
    const stale = { ...claimed, capabilityKey: "nope.nope", nextEvaluationAt: now };

    await evaluateAlert(stale, { db, evaluateBinding: bindingFor(notMetResult()) });

    const after = (await getAlert(db, { id: alert.id }))!;
    expect(after.evaluationLeaseId).toBeNull();
    expect(after.nextEvaluationAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await listAlertEvents(db, alert.id)).toHaveLength(0);
  });

  it("successful evaluation schedules the next grid slot, not now + cadence", async () => {
    const alert = await createAlert(db, { ...BASE });
    const cadenceMs = 300_000;
    const phase = alertPhaseOffsetMs(alert.id);
    const slot = Math.floor((Date.now() - phase) / cadenceMs) * cadenceMs + phase;
    const due = new Date(slot - cadenceMs);
    await rawSql`UPDATE "Alert" SET "nextEvaluationAt" = ${due.toISOString()}::timestamptz WHERE id = ${alert.id}`;
    const claimed = await claimOne(new Date());

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(notMetResult()),
      enqueueDelivery: async () => {},
    });

    const after = (await getAlert(db, { id: alert.id }))!;
    expect(after.nextEvaluationAt!.getTime()).toBe(slot + cadenceMs);
  });

  it("first evaluation of a fresh alert joins the grid instead of re-running immediately", async () => {
    const alert = await createAlert(db, { ...BASE });
    await rawSql`UPDATE "Alert" SET "nextEvaluationAt" = NULL WHERE id = ${alert.id}`;
    const now = new Date();
    const claimed = await claimOne(now);
    expect(claimed.nextEvaluationAt).toBeNull();

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(notMetResult()),
      enqueueDelivery: async () => {},
    });

    const after = (await getAlert(db, { id: alert.id }))!;
    const phase = alertPhaseOffsetMs(alert.id);
    const expected = (Math.floor((now.getTime() - phase) / 300_000) + 1) * 300_000 + phase;
    expect(after.nextEvaluationAt!.getTime()).toBe(expected);
  });

  it("clears lastError on a successful evaluation", async () => {
    await createAlert(db, { ...BASE });
    const now1 = new Date();
    const claimed1 = await claimOne(now1);

    await evaluateAlert(claimed1, {
      db,
      evaluateBinding: bindingFor({
        kind: "stateful",
        outcome: "unavailable",
        facts: { unavailableReason: "stale_beyond_horizon" },
      }),
      enqueueDelivery: async () => {},
    });

    const now2 = new Date(now1.getTime() + 301_000);
    const claimed2 = await claimOne(now2);
    await evaluateAlert(claimed2, {
      db,
      evaluateBinding: bindingFor(metResult()),
      enqueueDelivery: async () => {},
    });

    const alert = await getAlert(db, { id: claimed2.id });
    const state = alert!.evaluatorState as Record<string, unknown>;
    expect(state.lastError).toBeNull();
  });

  it("returns unavailableReason in outcome", async () => {
    await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor({
        kind: "stateful",
        outcome: "unavailable",
        facts: { unavailableReason: "empty_result" },
      }),
      enqueueDelivery: async () => {},
    });

    expect(outcome.unavailableReason).toBe("empty_result");
  });

  it("unavailable without explicit reason gets 'unknown'", async () => {
    await createAlert(db, { ...BASE });
    const now = new Date();
    const claimed = await claimOne(now);

    await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(unavailableResult()),
      enqueueDelivery: async () => {},
    });

    const alert = await getAlert(db, { id: claimed.id });
    const state = alert!.evaluatorState as Record<string, unknown>;
    expect(state.lastError).not.toBeNull();
    expect((state.lastError as { reason: string }).reason).toBe("unknown");
  });
});

describe("occurrence seen dedup", () => {
  const OCC_BASE = { ...BASE, condition: { kind: "occurrence" } as Record<string, unknown> };

  async function evalWith(now: Date, result: EvaluationResult) {
    const claimed = await claimOne(now);
    return evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(result),
      enqueueDelivery: async () => {},
    });
  }

  async function alertRow(id: string) {
    const rows =
      await rawSql`SELECT attention, "occurrencesSinceRaise" AS occurrences_since_raise, "occurrencesTotal" AS occurrences_total, "lastOccurrenceAt" AS last_occurrence_at FROM "Alert" WHERE id = ${id}`;
    return rows[0]!;
  }

  it("T0 raise, T1 new rows count only, T2 resolve, T3 replay of seen rows does not re-raise", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const t0 = new Date();
    const a = occ("A", new Date(t0.getTime() - 180_000));
    const b = occ("B", new Date(t0.getTime() - 120_000));
    const c = occ("C", new Date(t0.getTime() - 60_000));

    const first = await evalWith(t0, occurrenceResult([a]));
    expect(first.events).toEqual(["raised"]);

    const t1 = new Date(t0.getTime() + 301_000);
    const second = await evalWith(t1, occurrenceResult([c, b, a]));
    expect(second.applied).toBe(true);
    expect(second.events).toEqual([]);
    const afterT1 = await alertRow(alert.id);
    expect(afterT1.attention).toBe("needs_attention");
    expect(afterT1.occurrences_since_raise).toBe(3);
    expect(Number(afterT1.occurrences_total)).toBe(3);
    expect(new Date(afterT1.last_occurrence_at).getTime()).toBe(c.rowTime.getTime());

    expect(await resolveAlert(db, { id: alert.id, actorId: "user_1" })).not.toBeNull();

    const t3 = new Date(t1.getTime() + 301_000);
    const third = await evalWith(t3, occurrenceResult([c, b, a]));
    expect(third.applied).toBe(true);
    expect(third.events).toEqual([]);
    expect((await alertRow(alert.id)).attention).toBe("clear");

    const events = await listAlertEvents(db, alert.id);
    expect(events.filter((e) => e.type === "raised")).toHaveLength(1);
  });

  it("replay of only seen keys after resolve keeps attention clear and writes no event", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const t0 = new Date();
    const a = occ("A", new Date(t0.getTime() - 60_000));

    await evalWith(t0, occurrenceResult([a]));
    await resolveAlert(db, { id: alert.id, actorId: "user_1" });

    const replay = await evalWith(new Date(t0.getTime() + 301_000), occurrenceResult([a]));
    expect(replay.events).toEqual([]);
    const row = await alertRow(alert.id);
    expect(row.attention).toBe("clear");
    expect(Number(row.occurrences_total)).toBe(1);
    const events = await listAlertEvents(db, alert.id);
    expect(events.map((e) => e.type).sort()).toEqual(["raised", "resolved"]);
  });

  it("late-ingested unseen row sorting behind a seen row raises bound to the unseen row", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const t0 = new Date();
    const c = occ("C", new Date(t0.getTime() - 60_000));
    const d = occ("D", new Date(t0.getTime() - 300_000));

    await evalWith(t0, occurrenceResult([c]));
    await resolveAlert(db, { id: alert.id, actorId: "user_1" });

    const late = await evalWith(new Date(t0.getTime() + 301_000), occurrenceResult([c, d]));
    expect(late.events).toEqual(["raised"]);
    const raised = (await listAlertEvents(db, alert.id)).filter((e) => e.type === "raised");
    expect(raised.map((e) => e.sourceEventId).sort()).toEqual(["C", "D"]);
    expect((await alertRow(alert.id)).attention).toBe("needs_attention");
    const latest = raised.find((e) => e.sourceEventId === "D");
    expect(latest?.facts).toEqual({ key: "D" });
  });

  it("evaluation whose lease is cleared by resolve mid-flight writes no seen rows or events", async () => {
    const alert = await createAlert(db, { ...OCC_BASE, attention: "needs_attention" });
    const claimed = await claimOne(new Date());

    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: async () => {
        await resolveAlert(db, { id: alert.id, actorId: "user_1" });
        return { result: occurrenceResult([occ("A", new Date(Date.now() - 60_000))]) };
      },
      enqueueDelivery: async () => {},
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.events).toEqual([]);
    const seen = await rawSql`SELECT 1 FROM "AlertOccurrenceSeen" WHERE "alertId" = ${alert.id}`;
    expect(seen).toHaveLength(0);
    const events = await listAlertEvents(db, alert.id);
    expect(events.map((e) => e.type)).toEqual(["resolved"]);
  });

  it("expired-but-present seen row is treated as unseen and its expiry is refreshed", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const now = new Date();
    const past = new Date(now.getTime() - 8 * DAY_MS);
    await rawSql`INSERT INTO "AlertOccurrenceSeen" ("alertId", "sourceEventId", "rowTime", "seenAt", "expiresAt") VALUES (${alert.id}, 'A', ${past.toISOString()}::timestamptz, ${past.toISOString()}::timestamptz, ${new Date(now.getTime() - DAY_MS).toISOString()}::timestamptz)`;

    const a = occ("A", new Date(now.getTime() - 60_000));
    const outcome = await evalWith(now, occurrenceResult([a]));

    expect(outcome.events).toEqual(["raised"]);
    const rows =
      await rawSql`SELECT "expiresAt" AS expires_at FROM "AlertOccurrenceSeen" WHERE "alertId" = ${alert.id} AND "sourceEventId" = 'A'`;
    expect(new Date(rows[0]!.expires_at).getTime()).toBe(a.expiresAt.getTime());
  });

  it("drops occurrences with an empty key and counts only unique keyed rows", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const now = new Date();
    const keyless = {
      sourceEventId: "",
      rowTime: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() + DAY_MS),
      facts: { key: "none" },
    };
    const k = occ("K", new Date(now.getTime() - 60_000));
    const errors: string[] = [];

    const claimed = await claimOne(now);
    const outcome = await evaluateAlert(claimed, {
      db,
      evaluateBinding: bindingFor(occurrenceResult([keyless, keyless, k])),
      enqueueDelivery: async () => {},
      logger: { debug: () => {}, error: (message) => errors.push(message) },
    });

    expect(outcome.events).toEqual(["raised"]);
    const events = await listAlertEvents(db, alert.id);
    expect(events.map((e) => e.sourceEventId)).toEqual(["K"]);
    const row = await alertRow(alert.id);
    expect(Number(row.occurrences_total)).toBe(1);
    expect(row.occurrences_since_raise).toBe(1);
    expect(errors).toContain("alerts.occurrence_source_event_id_missing");
  });

  it("same key returned twice counts once", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const now = new Date();
    const k = occ("K", new Date(now.getTime() - 60_000));

    const outcome = await evalWith(now, occurrenceResult([k, k]));

    expect(outcome.events).toEqual(["raised"]);
    const row = await alertRow(alert.id);
    expect(Number(row.occurrences_total)).toBe(1);
    expect(row.occurrences_since_raise).toBe(1);
  });

  it("raised event binds to the latest occurrence when rows arrive out of order (mutation: first row)", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const now = new Date();
    const x = occ("X", new Date(now.getTime() - 120_000));
    const y = occ("Y", new Date(now.getTime() - 30_000));
    const z = occ("Z", new Date(now.getTime() - 200_000));

    await evalWith(now, occurrenceResult([x, y, z]));

    const raised = (await listAlertEvents(db, alert.id)).filter((e) => e.type === "raised");
    expect(raised.map((e) => e.sourceEventId)).toEqual(["Y"]);
    expect(raised[0]!.facts).toEqual({ key: "Y" });
  });

  it("last_occurrence_at is the max rowTime of unseen rows regardless of order", async () => {
    const alert = await createAlert(db, OCC_BASE);
    const now = new Date();
    const x = occ("X", new Date(now.getTime() - 120_000));
    const y = occ("Y", new Date(now.getTime() - 30_000));
    const z = occ("Z", new Date(now.getTime() - 200_000));

    await evalWith(now, occurrenceResult([x, y, z]));

    const row = await alertRow(alert.id);
    expect(new Date(row.last_occurrence_at).getTime()).toBe(y.rowTime.getTime());
  });
});
