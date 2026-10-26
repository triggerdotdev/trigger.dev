import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  applyEvaluationOutcome,
  claimAlertsForEvaluation,
  claimDelivery,
  createAlert,
  failExhaustedDelivery,
  getAlert,
  listActiveSeenOccurrenceKeys,
  listAlertEvents,
  releaseDelivery,
  sweepExpiredOccurrenceSeen,
} from "~/v3/services/alerts/storage/alertStore.server";
import { applyAlertsMigration } from "./helpers/alertTables";

vi.setConfig({ testTimeout: 60_000 });

const BASE = {
  organizationId: "org_1",
  projectId: "proj_1",
  environmentId: "env_1",
  capabilityKey: "queue.depth",
  params: { queue: "worker-1" } as Record<string, unknown>,
  condition: { operator: ">", value: 100 } as Record<string, unknown>,
  createdBy: "user_1",
  notifiers: [{ type: "channel" as const, channelId: "chan_1" }],
};

async function claimLease(prisma: PrismaClient) {
  const [claimed] = await claimAlertsForEvaluation(prisma, {
    now: new Date(),
    leaseMs: 60_000,
    limit: 1,
  });
  return claimed!.evaluationLeaseId;
}

function occurrence(sourceEventId: string, now: Date) {
  return { sourceEventId, rowTime: now, expiresAt: new Date(now.getTime() + 60_000) };
}

describe("alertStore", () => {
  postgresTest("a stale lease writes no events, seen rows or counters", async ({ prisma }) => {
    await applyAlertsMigration(prisma);
    const alert = await createAlert(prisma, BASE);
    const leaseId = await claimLease(prisma);
    const now = new Date();

    const result = await applyEvaluationOutcome(prisma, {
      alertId: alert.id,
      leaseId: "stale_lease",
      patch: { attention: "needs_attention" },
      events: [{ type: "raised", sourceEventId: "k1" }],
      deliveries: [{ alertEventIndex: 0, notifier: BASE.notifiers[0] }],
      occurrences: [occurrence("k1", now)],
      occurrenceCounters: { add: 1, latestAt: now, resetSinceRaise: true },
    });

    expect(result).toEqual({ applied: false, events: [], deliveries: [], alert: null });
    expect(await listAlertEvents(prisma, alert.id)).toEqual([]);
    expect(
      await listActiveSeenOccurrenceKeys(prisma, { alertId: alert.id, keys: ["k1"], now })
    ).toEqual(new Set());
    expect(await getAlert(prisma, { id: alert.id })).toMatchObject({
      attention: "clear",
      occurrencesTotal: 0,
      occurrencesSinceRaise: 0,
      lastOccurrenceAt: null,
    });

    const later = new Date(now.getTime() + 60_000);
    const applyCounters = async (
      lease: string,
      counters: { add: number; latestAt: Date; resetSinceRaise: boolean }
    ) =>
      applyEvaluationOutcome(prisma, {
        alertId: alert.id,
        leaseId: lease,
        patch: {},
        events: [],
        deliveries: [],
        occurrenceCounters: counters,
      });
    await applyCounters(leaseId, { add: 2, latestAt: later, resetSinceRaise: false });
    await applyCounters(await claimLease(prisma), { add: 1, latestAt: now, resetSinceRaise: true });
    expect(await getAlert(prisma, { id: alert.id })).toMatchObject({
      occurrencesTotal: 3,
      occurrencesSinceRaise: 1,
      lastOccurrenceAt: later,
    });
  });

  postgresTest("a concurrent eval claim skips the locked alert", async ({ prisma }) => {
    await applyAlertsMigration(prisma);
    const alert = await createAlert(prisma, BASE);
    const now = new Date();

    await prisma.$transaction(
      async (tx) => {
        const first = await claimAlertsForEvaluation(tx, { now, leaseMs: 60_000, limit: 10 });
        expect(first.map((a) => a.id)).toEqual([alert.id]);
        const second = await claimAlertsForEvaluation(prisma, { now, leaseMs: 60_000, limit: 10 });
        expect(second).toEqual([]);
      },
      { timeout: 10_000 }
    );
  });

  postgresTest("an exhausted delivery is not re-claimable and fails", async ({ prisma }) => {
    await applyAlertsMigration(prisma);
    const alert = await createAlert(prisma, BASE);
    const outcome = await applyEvaluationOutcome(prisma, {
      alertId: alert.id,
      leaseId: await claimLease(prisma),
      patch: { attention: "needs_attention" },
      events: [{ type: "raised" }],
      deliveries: [{ alertEventIndex: 0, notifier: BASE.notifiers[0] }],
    });
    const delivery = outcome.deliveries[0]!;
    const params = {
      id: delivery.id,
      eventAt: delivery.eventAt,
      staleBefore: new Date(0),
      cap: { maxAttempts: 2, maxAgeMs: 60 * 60_000 },
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const claim = await claimDelivery(prisma, params);
      expect(claim?.delivery).toMatchObject({ status: "delivering", attempts: attempt });
      expect(await releaseDelivery(prisma, { ...params, claimId: "someone_else" })).toBeNull();
      expect(await releaseDelivery(prisma, { ...params, claimId: claim!.claimId })).toMatchObject({
        status: "pending",
        claimId: null,
      });
    }

    expect(await claimDelivery(prisma, params)).toBeNull();
    expect(await failExhaustedDelivery(prisma, params)).toBe(true);
    const row = await prisma.alertDelivery.findFirst({ where: { id: delivery.id } });
    expect(row).toMatchObject({ status: "failed", failureReason: "retries_exhausted" });
    expect(await claimDelivery(prisma, params)).toBeNull();
  });

  postgresTest("seen rows dedupe by alert and key until swept", async ({ prisma }) => {
    await applyAlertsMigration(prisma);
    const alert = await createAlert(prisma, BASE);
    const now = new Date();
    const apply = async () =>
      applyEvaluationOutcome(prisma, {
        alertId: alert.id,
        leaseId: await claimLease(prisma),
        patch: {},
        events: [],
        deliveries: [],
        occurrences: [occurrence("k1", now), occurrence("k1", new Date(now.getTime() - 1_000))],
      });

    expect((await apply()).applied).toBe(true);
    expect(await prisma.alertOccurrenceSeen.count({ where: { alertId: alert.id } })).toBe(1);
    expect(
      await listActiveSeenOccurrenceKeys(prisma, { alertId: alert.id, keys: ["k1"], now })
    ).toEqual(new Set(["k1"]));

    await expect(apply()).rejects.toThrow("alerts.seen_conflict");

    const later = new Date(now.getTime() + 120_000);
    expect(await sweepExpiredOccurrenceSeen(prisma, { now: later, batch: 10 })).toBe(1);
    expect(await prisma.alertOccurrenceSeen.count({ where: { alertId: alert.id } })).toBe(0);
  });
});
