import type { Watch } from "@internal/dashboard-agent-db";
import { describe, expect, it } from "vitest";

import {
  runWatchTick,
  type WatchTickDeps,
  type WatchTickPayload,
  type WatchTickStore,
} from "./watch-tick";
import type { WatchWakeAction } from "./dashboard-agent";

/**
 * The tick's lifecycle, driven through the `deps` seam: a fake store over an
 * in-memory row (with the real queries' guards — every transition is conditional
 * on the row's current state), a fake fetch, and a fake session append. No mocks
 * and no database: what's under test is the ordering, and the ordering is where
 * a wake gets lost or sent twice.
 */

const PAYLOAD: WatchTickPayload = {
  watchId: "watch_1",
  token: "watch_token",
  apiOrigin: "http://localhost:3030",
};

const NOW = new Date("2026-01-01T12:00:00.000Z");

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
    lastCheckedAt: null,
    firedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    lastResult: null,
    tickCount: 0,
    ...overrides,
  } as Watch;
}

// A store over one row, guarded exactly like the real queries: the condition
// transition only applies to an `active` row, and the delivery mark only to a
// `pending` delivery.
function fakeStore(row: Watch) {
  const calls = {
    transition: [] as unknown[],
    delivered: [] as unknown[],
    ticks: [] as unknown[],
  };
  const store: WatchTickStore = {
    getWatch: async () => ({ ...row }),
    transitionWatchCondition: async (params) => {
      calls.transition.push(params);
      if (row.status !== "active") return null;
      row.status = params.status;
      row.deliveryStatus = "pending";
      row.lastCheckedAt = NOW;
      if (params.status === "fired") row.firedAt = NOW;
      if (params.lastResult !== undefined) row.lastResult = params.lastResult;
      return { ...row };
    },
    markWatchDelivered: async (params) => {
      calls.delivered.push(params);
      if (row.deliveryStatus !== "pending") return null;
      row.deliveryStatus = "delivered";
      row.deliveredAt = NOW;
      return { ...row };
    },
    recordWatchTick: async (params) => {
      calls.ticks.push(params);
      if (row.status !== "active") return null;
      row.tickCount = params.tickCount ?? row.tickCount + 1;
      row.lastCheckedAt = NOW;
      if (params.lastResult !== undefined) row.lastResult = params.lastResult;
      return { tickCount: row.tickCount, lastCheckedAt: row.lastCheckedAt };
    },
  };
  return { store, calls, row };
}

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(responder: (call: FetchCall) => { status?: number; body: unknown }): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function fakeDeliver(options: { throwOnce?: boolean } = {}) {
  const appends: Array<{ chatId: string; action: WatchWakeAction }> = [];
  let thrown = false;
  return {
    appends,
    deliver: async ({ chatId, action }: { chatId: string; action: WatchWakeAction }) => {
      if (options.throwOnce && !thrown) {
        thrown = true;
        throw new Error("session append failed");
      }
      appends.push({ chatId, action });
    },
  };
}

function fakeNotifyFired(options: { throws?: boolean } = {}) {
  const notified: string[] = [];
  return {
    notified,
    notifyFired: async (watchId: string) => {
      notified.push(watchId);
      if (options.throws) throw new Error("the fired callback returned 500");
    },
  };
}

function fakeReschedule() {
  const triggers: Array<{ payload: WatchTickPayload; options: Record<string, unknown> }> = [];
  return {
    triggers,
    reschedule: async (payload: WatchTickPayload, options: Record<string, unknown>) => {
      triggers.push({ payload, options });
    },
  };
}

// Assemble the seams into one deps object.
function deps(parts: {
  store: WatchTickStore;
  fetch: typeof fetch;
  deliver: WatchTickDeps["deliver"];
  reschedule: WatchTickDeps["reschedule"];
  notifyFired?: WatchTickDeps["notifyFired"];
  now?: Date;
}): WatchTickDeps {
  return {
    store: parts.store,
    fetch: parts.fetch,
    deliver: parts.deliver,
    reschedule: parts.reschedule,
    notifyFired: parts.notifyFired ?? (async () => {}),
    now: () => parts.now ?? NOW,
  };
}

describe("runWatchTick", () => {
  it("pending: records the tick and reschedules on the spec's cadence, keyed on the tick number", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "pending", tickCount: 4 });
    // The check went to the watch's own endpoint with the watch token, and was
    // NOT flagged final (the watch has an hour left).
    expect(fetchCalls[0]?.url).toBe(
      "http://localhost:3030/api/v1/dashboard-agent/watches/watch_1/check"
    );
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    ).toBe("Bearer watch_token");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({});

    // The counter is set explicitly to the value the key was built from, so a
    // retried invocation can't fork the tick chain.
    expect(calls.ticks).toEqual([{ id: "watch_1", tickCount: 4, lastResult: {} }]);
    expect(triggers).toEqual([
      { payload: PAYLOAD, options: { delay: "1m", idempotencyKey: "watch:watch_1:tick:4" } },
    ]);

    // Nothing terminal, nothing delivered.
    expect(row.status).toBe("active");
    expect(appends).toHaveLength(0);
  });

  it("satisfied: transitions to fired, appends the wake, then marks it delivered", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      body: { result: "satisfied", facts: { status: "COMPLETED", durationMs: 4200 } },
    }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();
    const { notified, notifyFired } = fakeNotifyFired();

    const result = await runWatchTick(
      PAYLOAD,
      deps({ store, fetch, deliver, reschedule, notifyFired })
    );

    expect(result).toEqual({ outcome: "fired" });
    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("delivered");
    expect(triggers).toHaveLength(0);

    // One wake, on the watch's own chat, carrying the check's facts and a
    // stable id.
    expect(appends).toHaveLength(1);
    expect(appends[0]?.chatId).toBe("chat_1");
    expect(appends[0]?.action).toMatchObject({
      type: "watch.fired",
      id: "watch:watch_1:fired",
      watchId: "watch_1",
      identity: "run_finished:run_a1",
      facts: { verified: true, status: "COMPLETED", durationMs: 4200 },
      note: "tell me when the receipt run finishes",
    });
    // Delivery is marked only after the append.
    expect(calls.delivered).toEqual([{ id: "watch_1" }]);
    // And the webapp is told once, so the configured alerts go out.
    expect(notified).toEqual(["watch_1"]);
  });

  it("a failing fired notification does not fail the tick", async () => {
    const { store, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const { notified, notifyFired } = fakeNotifyFired({ throws: true });

    const result = await runWatchTick(
      PAYLOAD,
      deps({ store, fetch, deliver, reschedule, notifyFired })
    );

    // The alert is best-effort; the wake is what the tick guarantees.
    expect(result).toEqual({ outcome: "fired" });
    expect(notified).toEqual(["watch_1"]);
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("an expiry does not notify: only a fired watch alerts", async () => {
    const { store, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const { notified, notifyFired } = fakeNotifyFired();

    const result = await runWatchTick(
      PAYLOAD,
      deps({
        store,
        fetch,
        deliver,
        reschedule,
        notifyFired,
        now: new Date("2026-01-01T13:00:01.000Z"),
      })
    );

    expect(result.outcome).toBe("expired");
    expect(row.status).toBe("expired");
    expect(notified).toEqual([]);
  });

  it("a run that started and finished between two ticks fires, it does not go terminal_unsatisfied", async () => {
    // The endpoint sees the run in a terminal-success state and says satisfied;
    // the tick must not read "it isn't running any more" as a miss.
    const { store, row } = fakeStore(
      watchRow({ tickCount: 1, spec: { ...watchRow().spec, kind: "run_start" } as Watch["spec"] })
    );
    const { fetch } = fakeFetch(() => ({
      body: { result: "satisfied", facts: { startedAt: "2026-01-01T11:59:00.000Z" } },
    }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result.outcome).toBe("fired");
    expect(row.status).toBe("fired");
    expect(appends[0]?.action.type).toBe("watch.fired");
  });

  it("crash between the transition and the append: the invocation throws, and the retry delivers only once", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 0 } } }));
    // The first append fails — the platform must retry the whole invocation.
    const { appends, deliver } = fakeDeliver({ throwOnce: true });
    const { reschedule } = fakeReschedule();
    const d = deps({ store, fetch, deliver, reschedule });

    await expect(runWatchTick(PAYLOAD, d)).rejects.toThrow("session append failed");

    // The row is terminal with the delivery still owed, and nothing was marked.
    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("pending");
    expect(calls.delivered).toHaveLength(0);
    expect(appends).toHaveLength(0);

    // The retry takes the delivery-only path: no second transition, one append.
    const retry = await runWatchTick(PAYLOAD, d);
    expect(retry).toEqual({ outcome: "delivered_only" });
    expect(calls.transition).toHaveLength(1);
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("a terminal, already-delivered watch does nothing at all", async () => {
    const { store, calls } = fakeStore(watchRow({ status: "fired", deliveryStatus: "delivered" }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "already_terminal" });
    expect(fetchCalls).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    expect(calls.transition).toHaveLength(0);
  });

  it("unavailable: a failed tick, never a fire and never a miss", async () => {
    const { store, calls, row } = fakeStore(
      watchRow({ tickCount: 2, lastResult: { pending: 12 } })
    );
    const { fetch } = fakeFetch(() => ({ status: 503, body: { error: "clickhouse is down" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "unavailable", tickCount: 3 });
    expect(row.status).toBe("active");
    expect(calls.transition).toHaveLength(0);
    expect(appends).toHaveLength(0);
    // Still watching, and the last good observation is kept.
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:3");
    expect(row.lastResult).toMatchObject({ checkFailed: true, previous: { pending: 12 } });
  });

  it("access_revoked: exits quietly, writing nothing", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { error: "no access", code: "access_revoked" },
    }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "revoked" });
    expect(row.status).toBe("active");
    expect(row.tickCount).toBe(0);
    expect(calls.transition).toHaveLength(0);
    expect(calls.ticks).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers).toHaveLength(0);
  });

  it("expiry with an unavailable final check: the watch still expires, and the facts say it couldn't be verified", async () => {
    const { store, row } = fakeStore(
      watchRow({
        tickCount: 30,
        lastCheckedAt: new Date("2026-01-01T12:50:00.000Z"),
        lastResult: { pending: 41 },
      })
    );
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({
      status: 500,
      body: { error: "metrics unavailable" },
    }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    // Past expiresAt (13:00) — the row is the authority, so this is the final check.
    const result = await runWatchTick(
      PAYLOAD,
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:00:01.000Z") })
    );

    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ final: true });
    expect(result).toEqual({ outcome: "expired" });
    expect(row.status).toBe("expired");
    expect(triggers).toHaveLength(0);
    expect(appends[0]?.action).toMatchObject({
      type: "watch.expired",
      id: "watch:watch_1:expired",
      facts: {
        verified: false,
        reason: "unverified_at_expiry",
        lastObservedAt: "2026-01-01T12:50:00.000Z",
        lastObservation: { pending: 41 },
      },
    });
  });

  it("expiry with a pending final check: it expires as not met, verified", async () => {
    const { store, row } = fakeStore(watchRow({ tickCount: 12 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "pending", facts: { pending: 7 } } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(
      PAYLOAD,
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:30:00.000Z") })
    );

    expect(result).toEqual({ outcome: "expired" });
    expect(row.status).toBe("expired");
    expect(triggers).toHaveLength(0);
    expect(appends[0]?.action.facts).toMatchObject({
      verified: true,
      reason: "not_met_by_expiry",
      pending: 7,
    });
  });

  it("terminal_unsatisfied: stops as an expiry that says it can never happen now", async () => {
    const { store, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      body: { result: "terminal_unsatisfied", facts: { status: "CANCELED" } },
    }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "expired" });
    expect(row.status).toBe("expired");
    expect(triggers).toHaveLength(0);
    expect(appends[0]?.action).toMatchObject({
      type: "watch.expired",
      facts: { verified: true, reason: "terminal_unsatisfied", status: "CANCELED" },
    });
  });

  it("a watch that no longer exists is a no-op", async () => {
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: {} }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const store: WatchTickStore = {
      getWatch: async () => null,
      transitionWatchCondition: async () => null,
      markWatchDelivered: async () => null,
      recordWatchTick: async () => null,
    };

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "missing" });
    expect(fetchCalls).toHaveLength(0);
    expect(appends).toHaveLength(0);
  });
});
