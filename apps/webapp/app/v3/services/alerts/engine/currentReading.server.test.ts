import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { createAlert, type Alert } from "../storage/alertStore.server";
import type { PrismaClient } from "@trigger.dev/database";
import { startAlertsPostgres } from "../../../../../test/helpers/alertTables";
import {
  createInMemoryCurrentReadingCache,
  getCurrentReading,
  type GetCurrentReadingDeps,
} from "./currentReading.server";
import type { EvaluateBindingFn } from "./evaluateAlert.server";

function alertFixture(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "alert_1",
    organizationId: "org_1",
    projectId: "proj_1",
    environmentId: "env_1",
    capabilityKey: "queue.depth",
    params: { queue: "worker-1" },
    condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
    query: null,
    expiresAt: null,
    lifecycle: "active",
    attention: "clear",
    observedCondition: "unknown",
    observedConditionChangedAt: null,
    pendingMetSince: null,
    evaluatorState: null,
    evaluationLeaseId: null,
    evaluationLeaseUntil: null,
    lastEvaluatedAt: null,
    nextEvaluationAt: null,
    notifiers: [],
    name: "Queue depth high",
    createdBy: "user_1",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    resolvedAt: null,
    resolvedBy: null,
    stoppedAt: null,
    stoppedBy: null,
    ...overrides,
  } as Alert;
}

describe("getCurrentReading", () => {
  it("returns the dispatcher's result as available and never calls applyEvaluationOutcome", async () => {
    const alert = alertFixture();
    let calls = 0;
    const evaluateBinding: EvaluateBindingFn = async () => {
      calls++;
      return { result: { kind: "stateful", outcome: "met", facts: { value: 150 } } };
    };

    const reading = await getCurrentReading(alert, {
      evaluateBinding,
      cache: createInMemoryCurrentReadingCache(),
    });

    expect(reading.status).toBe("available");
    if (reading.status === "available") {
      expect(reading.result.facts).toEqual({ value: 150 });
    }
    expect(calls).toBe(1);
  });

  it("degrades to unavailable with lastError when the dispatcher throws", async () => {
    const alert = alertFixture();
    const evaluateBinding: EvaluateBindingFn = async () => {
      throw new Error("clickhouse unavailable");
    };

    const reading = await getCurrentReading(alert, {
      evaluateBinding,
      cache: createInMemoryCurrentReadingCache(),
    });

    expect(reading.status).toBe("unavailable");
    if (reading.status === "unavailable") {
      expect(reading.lastError).toBe("clickhouse unavailable");
    }
  });

  it("degrades to unavailable when the capability key is unknown", async () => {
    const alert = alertFixture({ capabilityKey: "not.a.real.capability" });
    const evaluateBinding: EvaluateBindingFn = async () => {
      throw new Error("should not be called");
    };

    const reading = await getCurrentReading(alert, {
      evaluateBinding,
      cache: createInMemoryCurrentReadingCache(),
    });

    expect(reading).toMatchObject({ status: "unavailable" });
  });

  it("serves a cached reading within the TTL instead of calling the dispatcher again", async () => {
    const alert = alertFixture();
    let calls = 0;
    const evaluateBinding: EvaluateBindingFn = async () => {
      calls++;
      return { result: { kind: "stateful", outcome: "met", facts: { value: calls } } };
    };
    const cache = createInMemoryCurrentReadingCache();
    const deps: GetCurrentReadingDeps = { evaluateBinding, cache, cacheTtlMs: 30_000 };

    const first = await getCurrentReading(alert, deps);
    const second = await getCurrentReading(alert, deps);

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it("re-evaluates once the cache entry is older than the TTL", async () => {
    const alert = alertFixture();
    let calls = 0;
    const evaluateBinding: EvaluateBindingFn = async () => {
      calls++;
      return { result: { kind: "stateful", outcome: "met", facts: { value: calls } } };
    };
    const cache = createInMemoryCurrentReadingCache();
    let now = new Date("2026-09-17T00:00:00Z");

    await getCurrentReading(alert, { evaluateBinding, cache, cacheTtlMs: 1000, now: () => now });
    now = new Date(now.getTime() + 1001);
    await getCurrentReading(alert, { evaluateBinding, cache, cacheTtlMs: 1000, now: () => now });

    expect(calls).toBe(2);
  });

  it("caps the in-memory cache size instead of growing without bound", async () => {
    const cache = createInMemoryCurrentReadingCache({ maxSize: 5 });
    const evaluateBinding: EvaluateBindingFn = async () => ({
      result: { kind: "stateful", outcome: "met", facts: {} },
    });

    for (let i = 0; i < 20; i++) {
      await getCurrentReading(alertFixture({ id: `alert_${i}` }), { evaluateBinding, cache });
    }

    expect(cache.size()).toBeLessThanOrEqual(5);
  });
});

describe("getCurrentReading against the real production dispatcher", () => {
  let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    pg = await startAlertsPostgres();
    db = pg.prisma;
  }, 120_000);

  afterAll(async () => {
    await pg?.stop();
  });

  async function rowCounts() {
    const [alertRows, eventRows, deliveryRows] = await Promise.all([
      db.alert.findMany(),
      db.alertEvent.findMany(),
      db.alertDelivery.findMany(),
    ]);
    return { alerts: alertRows.length, events: eventRows.length, deliveries: deliveryRows.length };
  }

  const fakeCompositeBinding: EvaluateBindingFn = async () => ({
    result: {
      kind: "stateful",
      outcome: "not_met",
      facts: {
        components: {
          flow: { outcome: "not_met", effectiveParams: {} },
          execution: { outcome: "not_met", effectiveParams: {} },
          liveness: { outcome: "not_met", effectiveParams: {} },
        },
      },
    },
  });

  it("never writes to the alerts/events/deliveries tables (row counts unchanged before/after)", async () => {
    const alert = await createAlert(db, {
      organizationId: "org_reading",
      projectId: "proj_reading",
      environmentId: "env_reading",
      capabilityKey: "health.all",
      params: { environmentId: "env_reading", scope: { type: "all" } },
      condition: { kind: "state", stateKey: "health" },
      createdBy: "user_reading",
      notifiers: [],
    });

    const before = await rowCounts();

    const reading = await getCurrentReading(alert as Alert, {
      evaluateBinding: fakeCompositeBinding,
      cache: createInMemoryCurrentReadingCache(),
    });

    const after = await rowCounts();

    expect(reading.status).toBe("available");
    expect(after).toEqual(before);

    const reread = await db.alert.findMany();
    const rereadRow = reread.find((row) => row.id === alert.id);
    expect(rereadRow?.lastEvaluatedAt).toBeNull();
    expect(rereadRow?.evaluationLeaseId).toBeNull();
  });
});
