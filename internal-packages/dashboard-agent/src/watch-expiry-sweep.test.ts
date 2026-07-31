import type { Watch } from "@internal/dashboard-agent-db";
import { describe, expect, it } from "vitest";

import { sweepExpiredWatches, type WatchSweepDeps } from "./watch-expiry-sweep";
import type { WatchWakeAction } from "./dashboard-agent";

/**
 * The expiry backstop, driven through the same seam style as the tick's tests: a
 * fake store over in-memory rows carrying the real queries' guards. What's under
 * test is that a swept watch ends up exactly where a ticked one would — expired,
 * woken once, delivery marked — and that an already-resolved row is left alone.
 */

const NOW = new Date("2026-01-01T14:00:00.000Z");

function watchRow(overrides: Partial<Watch> = {}): Watch {
  return {
    id: "watch_1",
    chatId: "chat_1",
    identity: "run_finished:run_a1",
    spec: {
      kind: "run_finished",
      runId: "run_a1",
      checkEveryMinutes: 1,
      maxHours: 2,
      note: "tell me when the receipt run finishes",
    },
    status: "active",
    deliveryStatus: "not_required",
    cancelReason: null,
    organizationId: "org_1",
    projectId: "proj_1",
    environmentId: "env_1",
    userId: "user_1",
    createdAt: new Date("2026-01-01T11:00:00.000Z"),
    expiresAt: new Date("2026-01-01T13:00:00.000Z"),
    lastCheckedAt: new Date("2026-01-01T12:50:00.000Z"),
    firedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    lastResult: { pending: 3 },
    tickCount: 7,
    ...overrides,
  } as Watch;
}

function fakeSweep(rows: Watch[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const appends: Array<{ chatId: string; action: WatchWakeAction }> = [];
  const calls = { transition: [] as unknown[], delivered: [] as string[] };
  const notified: string[] = [];

  const deps: WatchSweepDeps = {
    store: {
      getWatch: async ({ id }) => {
        const row = byId.get(id);
        return row ? { ...row } : null;
      },
      transitionWatchCondition: async (params) => {
        calls.transition.push(params);
        const row = byId.get(params.id);
        if (!row || row.status !== "active") return null;
        row.status = params.status;
        row.deliveryStatus = "pending";
        row.lastCheckedAt = NOW;
        if (params.lastResult !== undefined) row.lastResult = params.lastResult;
        return { ...row };
      },
      markWatchDelivered: async ({ id }) => {
        calls.delivered.push(id);
        const row = byId.get(id);
        if (!row || row.deliveryStatus !== "pending") return null;
        row.deliveryStatus = "delivered";
        row.deliveredAt = NOW;
        return { ...row };
      },
    },
    listExpired: async () => rows.map((row) => ({ ...row })),
    deliver: async ({ chatId, action }) => {
      appends.push({ chatId, action });
    },
    notifyFired: async (watchId) => {
      notified.push(watchId);
    },
    now: () => NOW,
  };

  return { deps, rows: byId, appends, calls, notified };
}

describe("sweepExpiredWatches", () => {
  it("expires an overdue watch as unverified, wakes the chat once, and marks the delivery", async () => {
    const { deps, rows, appends, calls, notified } = fakeSweep([watchRow()]);

    const result = await sweepExpiredWatches(deps);

    expect(result).toEqual({ scanned: 1, expired: 1, deliveredOnly: 0, skipped: 0, failed: 0 });

    const row = rows.get("watch_1")!;
    expect(row.status).toBe("expired");
    expect(row.deliveryStatus).toBe("delivered");

    // The sweep ran no check, so the narration must not claim the condition didn't
    // happen — it carries the last observation instead.
    expect(appends).toHaveLength(1);
    expect(appends[0]?.chatId).toBe("chat_1");
    expect(appends[0]?.action).toMatchObject({
      type: "watch.expired",
      id: "watch:watch_1:expired",
      watchId: "watch_1",
      facts: {
        verified: false,
        reason: "unverified_at_expiry",
        checks: 7,
        lastObservedAt: "2026-01-01T12:50:00.000Z",
        lastObservation: { pending: 3 },
      },
    });
    expect(calls.delivered).toEqual(["watch_1"]);
    // An expiry never alerts.
    expect(notified).toEqual([]);
  });

  it("leaves an already-resolved watch alone", async () => {
    const { deps, rows, appends, calls } = fakeSweep([
      watchRow({ status: "fired", deliveryStatus: "delivered", firedAt: NOW }),
    ]);

    const result = await sweepExpiredWatches(deps);

    expect(result).toEqual({ scanned: 1, expired: 0, deliveredOnly: 0, skipped: 1, failed: 0 });
    expect(rows.get("watch_1")?.status).toBe("fired");
    expect(appends).toHaveLength(0);
    expect(calls.delivered).toHaveLength(0);
    // The transition was attempted and refused by the guard — nothing was written.
    expect(calls.transition).toHaveLength(1);
  });

  it("a watch someone else resolved but never delivered gets its wake", async () => {
    const { deps, rows, appends, calls } = fakeSweep([
      watchRow({ status: "fired", deliveryStatus: "pending", firedAt: NOW }),
    ]);

    const result = await sweepExpiredWatches(deps);

    expect(result).toEqual({ scanned: 1, expired: 0, deliveredOnly: 1, skipped: 0, failed: 0 });
    expect(appends).toHaveLength(1);
    expect(appends[0]?.action.type).toBe("watch.fired");
    expect(calls.delivered).toEqual(["watch_1"]);
    expect(rows.get("watch_1")?.deliveryStatus).toBe("delivered");
  });

  it("one failing row does not stop the batch, and the sweep fails loudly", async () => {
    const { deps, rows, appends } = fakeSweep([watchRow(), watchRow({ id: "watch_2" })]);
    const deliver = deps.deliver;
    deps.deliver = async (args) => {
      if (args.watch.id === "watch_1") throw new Error("session append failed");
      return deliver(args);
    };

    await expect(sweepExpiredWatches(deps)).rejects.toThrow("failed on 1 of 2 watches");

    // The failed row is terminal with the delivery still owed; the other is done.
    expect(rows.get("watch_1")?.deliveryStatus).toBe("pending");
    expect(rows.get("watch_2")?.deliveryStatus).toBe("delivered");
    expect(appends.map((append) => append.action.watchId)).toEqual(["watch_2"]);
  });
});
