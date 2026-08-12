import { watchResolutionToWireStatus } from "@internal/dashboard-agent-contracts";
import type { Watch } from "@internal/dashboard-agent-db";
import { describe, expect, it } from "vitest";

import {
  runWatchBatchTick,
  runWatchTick,
  type WatchBatchCheckEntry,
  type WatchBatchCheckResponse,
  type WatchBatchTickDeps,
  type WatchBatchTickPayload,
  type WatchTickDeps,
  type WatchTickPayload,
  type WatchTickStore,
} from "./watch-tick";
import type { WatchWakeAction } from "./dashboard-agent";

function payloadFor(tick: number): WatchTickPayload {
  return {
    watchId: "watch_1",
    token: "watch_token",
    apiOrigin: "http://localhost:3030",
    tick,
  };
}

const PAYLOAD = payloadFor(1);

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
    investigateOnAttention: false,
    organizationId: "org_1",
    projectId: "proj_1",
    projectRef: "proj_abc",
    environmentId: "env_1",
    userId: "user_1",
    createdAt: new Date("2026-01-01T11:00:00.000Z"),
    expiresAt: new Date("2026-01-01T13:00:00.000Z"),
    lastCheckedAt: null,
    firedAt: null,
    deliveryClaimedAt: null,
    deliveryClaimId: null,
    deliveredAt: null,
    cancelledAt: null,
    lastResult: null,
    tickCount: 0,
    ...overrides,
  } as Watch;
}

// Guarded exactly like the real queries. Several rows, because a batch tick's
// isolation is only real if its watches are separate rows.
function fakeStore(first: Watch, ...rest: Watch[]) {
  const rows = [first, ...rest];
  const byId = new Map(rows.map((row) => [row.id, row]));
  let claimSeq = 0;
  const calls = {
    claims: [] as unknown[],
    transition: [] as unknown[],
    deliveryClaims: [] as unknown[],
    released: [] as unknown[],
    delivered: [] as unknown[],
    checks: [] as unknown[],
  };
  const store: WatchTickStore = {
    getWatch: async ({ id }) => {
      const row = byId.get(id);
      return row ? { ...row } : null;
    },
    claimWatchTick: async (params) => {
      calls.claims.push(params);
      const row = byId.get(params.id);
      if (!row || row.status !== "active") return null;
      // Resumable like the real query: the previous generation or this one.
      if (row.tickCount !== params.generation - 1 && row.tickCount !== params.generation) {
        return null;
      }
      row.tickCount = params.generation;
      // Deliberately NOT lastCheckedAt: a claim is not an observation.
      return { ...row };
    },
    claimWatchDelivery: async (params) => {
      calls.deliveryClaims.push(params);
      const row = byId.get(params.id);
      if (!row) return null;
      const stale =
        row.deliveryStatus === "delivering" &&
        (row.deliveryClaimedAt ?? row.createdAt).getTime() <= params.staleBefore.getTime();
      if (row.deliveryStatus !== "pending" && !stale) return null;
      const claimId = `wdc_${++claimSeq}`;
      row.deliveryStatus = "delivering";
      row.deliveryClaimedAt = NOW;
      row.deliveryClaimId = claimId;
      return { watch: { ...row }, claimId };
    },
    releaseWatchDelivery: async (params) => {
      calls.released.push(params);
      const row = byId.get(params.id);
      if (!row) return null;
      // Fenced: only the deliverer whose token the row still holds may release it.
      if (row.deliveryStatus !== "delivering" || row.deliveryClaimId !== params.claimId)
        return null;
      row.deliveryStatus = "pending";
      row.deliveryClaimedAt = null;
      row.deliveryClaimId = null;
      return { ...row };
    },
    transitionWatchCondition: async (params) => {
      calls.transition.push(params);
      const row = byId.get(params.id);
      if (!row || row.status !== "active") return null;
      // Mirrors the query layer: status is derived from the resolution.
      const status = watchResolutionToWireStatus(params.resolution);
      row.status = status;
      row.resolution = params.resolution;
      row.deliveryStatus = "pending";
      row.lastCheckedAt = NOW;
      if (status === "fired") row.firedAt = NOW;
      if (params.observedOutcome !== undefined) row.observedOutcome = params.observedOutcome;
      if (params.lastResult !== undefined) row.lastResult = params.lastResult;
      return { ...row };
    },
    markWatchDelivered: async (params) => {
      calls.delivered.push(params);
      const row = byId.get(params.id);
      if (!row) return null;
      // Same fence: a mark from a taken-over deliverer completes nothing.
      if (row.deliveryStatus !== "delivering" || row.deliveryClaimId !== params.claimId)
        return null;
      row.deliveryStatus = "delivered";
      row.deliveredAt = NOW;
      return { ...row };
    },
    recordWatchCheck: async (params) => {
      calls.checks.push(params);
      const row = byId.get(params.id);
      if (!row || row.status !== "active") return null;
      row.lastCheckedAt = NOW;
      if (params.lastResult !== undefined) row.lastResult = params.lastResult;
      return { tickCount: row.tickCount, lastCheckedAt: row.lastCheckedAt };
    },
  };
  return { store, calls, row: first, rows, byId };
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

function deps(parts: {
  store: WatchTickStore;
  fetch: typeof fetch;
  deliver: WatchTickDeps["deliver"];
  reschedule: WatchTickDeps["reschedule"];
  notifyFired?: WatchTickDeps["notifyFired"];
  notifyInvestigate?: WatchTickDeps["notifyInvestigate"];
  now?: Date;
}): WatchTickDeps {
  return {
    store: parts.store,
    fetch: parts.fetch,
    deliver: parts.deliver,
    reschedule: parts.reschedule,
    notifyFired: parts.notifyFired ?? (async () => {}),
    notifyInvestigate: parts.notifyInvestigate ?? (async () => {}),
    now: () => parts.now ?? NOW,
  };
}

describe("runWatchTick", () => {
  it("pending: claims its generation, records the check, and reschedules the next generation", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(4), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "pending", tickCount: 4 });
    expect(calls.claims).toEqual([{ id: "watch_1", generation: 4 }]);
    expect(row.tickCount).toBe(4);
    expect(fetchCalls[0]?.url).toBe(
      "http://localhost:3030/api/v1/dashboard-agent/watches/watch_1/check"
    );
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    ).toBe("Bearer watch_token");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({});

    expect(calls.checks).toEqual([{ id: "watch_1", lastResult: {} }]);
    expect(triggers).toEqual([
      {
        payload: payloadFor(5),
        options: { delay: "1m", idempotencyKey: "watch:watch_1:tick:5" },
      },
    ]);

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
    expect(calls.delivered).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
    expect(notified).toEqual(["watch_1"]);
  });

  it("the wake carries the row's investigate-on-attention consent, and kicks the investigation", async () => {
    const { store } = fakeStore(watchRow({ investigateOnAttention: true }));
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const kicked: string[] = [];

    await runWatchTick(
      PAYLOAD,
      deps({
        store,
        fetch,
        deliver,
        reschedule,
        notifyInvestigate: async (watchId) => void kicked.push(watchId),
      })
    );

    expect(appends[0]?.action.investigateOnAttention).toBe(true);
    expect(kicked).toEqual(["watch_1"]);
  });

  it("kicks no investigation without the consent", async () => {
    const { store } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const kicked: string[] = [];

    await runWatchTick(
      PAYLOAD,
      deps({
        store,
        fetch,
        deliver,
        reschedule,
        notifyInvestigate: async (watchId) => void kicked.push(watchId),
      })
    );

    expect(kicked).toEqual([]);
  });

  it("a failing investigate kick does not fail the tick", async () => {
    const { store, row } = fakeStore(watchRow({ investigateOnAttention: true }));
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    const result = await runWatchTick(
      PAYLOAD,
      deps({
        store,
        fetch,
        deliver,
        reschedule,
        notifyInvestigate: async () => {
          throw new Error("the investigate callback returned 500");
        },
      })
    );

    expect(result).toEqual({ outcome: "fired" });
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("kicks the investigation on an expiry as well", async () => {
    const { store } = fakeStore(watchRow({ tickCount: 3, investigateOnAttention: true }));
    const { fetch } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const kicked: string[] = [];

    const result = await runWatchTick(
      payloadFor(4),
      deps({
        store,
        fetch,
        deliver,
        reschedule,
        notifyInvestigate: async (watchId) => void kicked.push(watchId),
        now: new Date("2026-01-01T13:00:01.000Z"),
      })
    );

    expect(result.outcome).toBe("expired");
    expect(kicked).toEqual(["watch_1"]);
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
      payloadFor(4),
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
    const { store, row } = fakeStore(
      watchRow({ tickCount: 1, spec: { ...watchRow().spec, kind: "run_start" } as Watch["spec"] })
    );
    const { fetch } = fakeFetch(() => ({
      body: { result: "satisfied", facts: { startedAt: "2026-01-01T11:59:00.000Z" } },
    }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(2), deps({ store, fetch, deliver, reschedule }));

    expect(result.outcome).toBe("fired");
    expect(row.status).toBe("fired");
    expect(appends[0]?.action.type).toBe("watch.fired");
  });

  it("crash between the transition and the append: the invocation throws, and the retry delivers only once", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 0 } } }));
    const { appends, deliver } = fakeDeliver({ throwOnce: true });
    const { reschedule } = fakeReschedule();
    const d = deps({ store, fetch, deliver, reschedule });

    await expect(runWatchTick(PAYLOAD, d)).rejects.toThrow("session append failed");

    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("pending");
    expect(calls.released).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
    expect(calls.delivered).toHaveLength(0);
    expect(appends).toHaveLength(0);

    const retry = await runWatchTick(PAYLOAD, d);
    expect(retry).toEqual({ outcome: "delivered_only" });
    expect(calls.transition).toHaveLength(1);
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("a release that fails too still surfaces the append error, not its own", async () => {
    const { store } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 0 } } }));
    const { deliver } = fakeDeliver({ throwOnce: true });
    const { reschedule } = fakeReschedule();
    const brokenRelease: WatchTickStore = {
      ...store,
      releaseWatchDelivery: async () => {
        throw new Error("the claim release failed");
      },
    };

    await expect(
      runWatchTick(PAYLOAD, deps({ store: brokenRelease, fetch, deliver, reschedule }))
    ).rejects.toThrow("session append failed");
  });

  it("a release that fails after a refused append still surfaces the refusal", async () => {
    const { store } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 0 } } }));
    const { reschedule } = fakeReschedule();
    const brokenRelease: WatchTickStore = {
      ...store,
      releaseWatchDelivery: async () => {
        throw new Error("the claim release failed");
      },
    };

    await expect(
      runWatchTick(
        PAYLOAD,
        deps({
          store: brokenRelease,
          fetch,
          deliver: async () => ({ appended: false }),
          reschedule,
        })
      )
    ).rejects.toThrow("wasn't appended");
  });

  it("two concurrent invocations of the same generation wake the chat exactly once", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 1 } } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const { notified, notifyFired } = fakeNotifyFired();
    const d = deps({ store, fetch, deliver, reschedule, notifyFired });

    const outcomes = (
      await Promise.all([runWatchTick(payloadFor(4), d), runWatchTick(payloadFor(4), d)])
    ).map((result) => result.outcome);

    expect(calls.deliveryClaims).toHaveLength(2);
    expect(appends).toHaveLength(1);
    expect(calls.delivered).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
    expect(notified).toEqual(["watch_1"]);
    expect(calls.transition).toHaveLength(2);
    expect(outcomes).toContain("fired");
    expect(outcomes).toContain("already_delivering");
    expect(row).toMatchObject({ status: "fired", deliveryStatus: "delivered" });
  });

  it("a live delivery claim is left alone, and a dead one is recovered", async () => {
    const fresh = fakeStore(
      watchRow({
        status: "fired",
        deliveryStatus: "delivering",
        deliveryClaimedAt: NOW,
        firedAt: NOW,
      })
    );
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { reschedule } = fakeReschedule();
    const live = fakeDeliver();

    expect(
      await runWatchTick(
        { ...payloadFor(0), deliverOnly: true },
        deps({ store: fresh.store, fetch, deliver: live.deliver, reschedule })
      )
    ).toEqual({ outcome: "already_delivering" });
    expect(live.appends).toHaveLength(0);
    expect(fresh.row.deliveryStatus).toBe("delivering");

    const dead = fakeStore(
      watchRow({
        status: "fired",
        deliveryStatus: "delivering",
        deliveryClaimedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
        firedAt: NOW,
      })
    );
    const recovered = fakeDeliver();

    expect(
      await runWatchTick(
        { ...payloadFor(0), deliverOnly: true },
        deps({ store: dead.store, fetch, deliver: recovered.deliver, reschedule })
      )
    ).toEqual({ outcome: "delivered_only" });
    expect(recovered.appends).toHaveLength(1);
    expect(dead.row.deliveryStatus).toBe("delivered");
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

    const result = await runWatchTick(payloadFor(3), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "unavailable", tickCount: 3 });
    expect(row.status).toBe("active");
    expect(calls.transition).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:4");
    expect(row.lastResult).toMatchObject({ checkFailed: true, previous: { pending: 12 } });
  });

  it("a run of failed checks does not nest: `previous` stays the last real observation", async () => {
    const { store, row } = fakeStore(
      watchRow({
        tickCount: 2,
        lastCheckedAt: new Date("2026-01-01T12:50:00.000Z"),
        lastResult: { pending: 12 },
      })
    );
    const { fetch } = fakeFetch(() => ({ status: 503, body: { error: "clickhouse is down" } }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const d = deps({ store, fetch, deliver, reschedule });

    for (const tick of [3, 4, 5, 6]) await runWatchTick(payloadFor(tick), d);

    // One level, not four: the row is serialised into the wake, the alert and the webhook.
    expect((row.lastResult as { previous?: unknown }).previous).toEqual({ pending: 12 });
  });

  it("the facts an unverified expiry carries are bounded by the same unwrap", async () => {
    const { store, row } = fakeStore(
      watchRow({
        tickCount: 28,
        lastCheckedAt: new Date("2026-01-01T12:50:00.000Z"),
        lastResult: { pending: 41 },
      })
    );
    const { fetch } = fakeFetch(() => ({ status: 500, body: { error: "metrics unavailable" } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    for (const tick of [29, 30, 31]) {
      await runWatchTick(payloadFor(tick), deps({ store, fetch, deliver, reschedule }));
    }
    await runWatchTick(
      payloadFor(32),
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:00:01.000Z") })
    );

    expect(row.status).toBe("expired");
    const facts = (appends[0]!.action as { facts: Record<string, unknown> }).facts;
    expect(facts.reason).toBe("unverified_at_expiry");
    const observation = facts.lastObservation as { checkFailed?: boolean; previous?: unknown };
    expect(observation.checkFailed).toBe(true);
    expect(observation.previous).toEqual({ pending: 41 });
  });

  it("access_revoked: exits without resolving, delivering, or rescheduling", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      status: 403,
      body: { error: "no access", code: "access_revoked" },
    }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "revoked" });
    expect(calls.transition).toHaveLength(0);
    expect(calls.checks).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    expect(row.tickCount).toBe(1);
  });

  it("an unrecognized 403 is a failed check, not a silent exit: it reschedules", async () => {
    // Anything but access_revoked/cancelled/not_found leaves the row active.
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 1 }));
    const { fetch } = fakeFetch(() => ({ status: 403, body: { error: "nope" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(2), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "unavailable", tickCount: 2 });
    expect(row.status).toBe("active");
    expect(calls.transition).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:3");
    expect(row.lastResult).toMatchObject({ checkFailed: true });
  });

  it("a late duplicate of an old generation claims nothing: the chain can't fork", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();
    const d = deps({ store, fetch, deliver, reschedule });

    expect(await runWatchTick(payloadFor(4), d)).toEqual({ outcome: "pending", tickCount: 4 });
    expect(await runWatchTick(payloadFor(5), d)).toEqual({ outcome: "pending", tickCount: 5 });

    // A duplicate of generation 4, arriving after its successor ran.
    const late = await runWatchTick(payloadFor(4), d);

    expect(late).toEqual({ outcome: "stale" });
    expect(fetchCalls).toHaveLength(2);
    expect(calls.checks).toHaveLength(2);
    expect(triggers.map((trigger) => trigger.options.idempotencyKey)).toEqual([
      "watch:watch_1:tick:5",
      "watch:watch_1:tick:6",
    ]);
    expect(calls.transition).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(row.tickCount).toBe(5);
  });

  it("a retry of a generation that crashed before its successor was accepted resumes it", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    let failNextTrigger = true;
    const d = deps({
      store,
      fetch,
      deliver,
      reschedule: async (next, options) => {
        if (failNextTrigger) {
          failNextTrigger = false;
          throw new Error("the trigger failed");
        }
        return reschedule(next, options);
      },
    });

    await expect(runWatchTick(payloadFor(4), d)).rejects.toThrow("the trigger failed");
    expect(row.tickCount).toBe(4);
    expect(triggers).toHaveLength(0);

    // Refusing the claim would leave the chain with no successor at all.
    const retry = await runWatchTick(payloadFor(4), d);

    expect(retry).toEqual({ outcome: "pending", tickCount: 4 });
    expect(calls.claims).toEqual([
      { id: "watch_1", generation: 4 },
      { id: "watch_1", generation: 4 },
    ]);
    expect(fetchCalls).toHaveLength(2);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.payload).toEqual(payloadFor(5));
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:5");
    expect(row.status).toBe("active");
    expect(row.tickCount).toBe(4);
    expect(appends).toHaveLength(0);
  });

  it("a resumed generation past the deadline still resolves exactly once", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 12 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 1 } } }));
    const { appends, deliver } = fakeDeliver({ throwOnce: true });
    const { reschedule } = fakeReschedule();
    const d = deps({ store, fetch, deliver, reschedule });

    await expect(runWatchTick(payloadFor(13), d)).rejects.toThrow("session append failed");
    const retry = await runWatchTick(payloadFor(13), d);

    expect(retry).toEqual({ outcome: "delivered_only" });
    expect(calls.transition).toHaveLength(1);
    expect(appends).toHaveLength(1);
    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("deliverOnly: wakes a resolved watch without claiming, checking, or rescheduling", async () => {
    const { store, calls, row } = fakeStore(
      watchRow({
        status: "fired",
        deliveryStatus: "pending",
        firedAt: NOW,
        lastResult: { runs: 2 },
      })
    );
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(
      { ...payloadFor(0), deliverOnly: true },
      deps({ store, fetch, deliver, reschedule })
    );

    expect(result).toEqual({ outcome: "delivered_only" });
    expect(calls.claims).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    expect(appends).toHaveLength(1);
    expect(appends[0]?.action).toMatchObject({ type: "watch.fired", id: "watch:watch_1:fired" });
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("deliverOnly on a watch that is still active decides nothing", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(
      { ...payloadFor(0), deliverOnly: true },
      deps({ store, fetch, deliver, reschedule })
    );

    expect(result).toEqual({ outcome: "nothing_to_deliver" });
    expect(calls.claims).toHaveLength(0);
    expect(calls.transition).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(row.status).toBe("active");
    expect(row.tickCount).toBe(0);
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

    const result = await runWatchTick(
      payloadFor(31),
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
      payloadFor(13),
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
      claimWatchTick: async () => null,
      transitionWatchCondition: async () => null,
      claimWatchDelivery: async () => null,
      releaseWatchDelivery: async () => null,
      markWatchDelivered: async () => null,
      recordWatchCheck: async () => null,
    };

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "missing" });
    expect(fetchCalls).toHaveLength(0);
    expect(appends).toHaveLength(0);
  });
});

describe("the resolution model", () => {
  const OBSERVED = {
    kind: "run_finished" as const,
    verified: true,
    finalStatus: "COMPLETED_WITH_ERRORS",
    durationMs: 4200,
  };

  it("records condition_met with the observation, and keeps the wire encoding", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      body: {
        result: "satisfied",
        facts: { outcome: "COMPLETED_WITH_ERRORS" },
        observed: OBSERVED,
      },
    }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(calls.transition).toEqual([
      {
        id: "watch_1",
        resolution: "condition_met",
        observedOutcome: OBSERVED,
        lastResult: { verified: true, outcome: "COMPLETED_WITH_ERRORS" },
      },
    ]);
    expect(row.resolution).toBe("condition_met");

    expect(appends[0]?.action).toMatchObject({
      type: "watch.fired",
      id: "watch:watch_1:fired",
      resolution: "condition_met",
      observed: OBSERVED,
    });
  });

  it("records condition_impossible, not a plain expiry", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({
      body: { result: "terminal_unsatisfied", facts: { status: "CANCELED" } },
    }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(calls.transition[0]).toMatchObject({ resolution: "condition_impossible" });
    expect(row.resolution).toBe("condition_impossible");
    expect(appends[0]?.action).toMatchObject({
      id: "watch:watch_1:expired",
      resolution: "condition_impossible",
    });
  });

  // A condition true exactly at the deadline resolves `condition_met`.
  it("lets the boundary check still resolve condition_met", async () => {
    const { store, calls } = fakeStore(watchRow({ tickCount: 12 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({
      body: { result: "satisfied", facts: { pending: 0 } },
    }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    const result = await runWatchTick(
      payloadFor(13),
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:30:00.000Z") })
    );

    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({ final: true });
    expect(calls.transition[0]).toMatchObject({ resolution: "condition_met" });
    expect(result).toEqual({ outcome: "fired" });
  });

  it("lets the boundary check still resolve condition_impossible", async () => {
    const { store, calls } = fakeStore(watchRow({ tickCount: 12 }));
    const { fetch } = fakeFetch(() => ({
      body: { result: "terminal_unsatisfied", facts: { status: "CANCELED" } },
    }));
    const { deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    await runWatchTick(
      payloadFor(13),
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:30:00.000Z") })
    );

    expect(calls.transition[0]).toMatchObject({ resolution: "condition_impossible" });
  });

  it("only a pending or unavailable boundary check becomes window_completed", async () => {
    for (const body of [{ result: "pending" as const, facts: { pending: 7 } }, undefined]) {
      const { store, calls } = fakeStore(watchRow({ tickCount: 12 }));
      const { fetch } = fakeFetch(() =>
        body ? { body } : { status: 500, body: { error: "clickhouse is down" } }
      );
      const { deliver } = fakeDeliver();
      const { reschedule } = fakeReschedule();

      await runWatchTick(
        payloadFor(13),
        deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:30:00.000Z") })
      );

      expect(calls.transition[0]).toMatchObject({ resolution: "window_completed" });
    }
  });

  it("resolves nothing on a pending or unavailable check inside the window", async () => {
    for (const body of [{ result: "pending" as const, facts: {} }, undefined]) {
      const { store, calls, row } = fakeStore(watchRow());
      const { fetch } = fakeFetch(() =>
        body ? { body } : { status: 503, body: { error: "down" } }
      );
      const { deliver } = fakeDeliver();
      const { reschedule } = fakeReschedule();

      await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

      expect(calls.transition).toHaveLength(0);
      expect(row.status).toBe("active");
      expect(row.resolution ?? null).toBeNull();
    }
  });

  it("carries an unverified observation through a window that could not be confirmed", async () => {
    const { store, calls } = fakeStore(watchRow({ tickCount: 12 }));
    const { fetch } = fakeFetch(() => ({
      body: {
        result: "unavailable",
        error: "metrics unavailable",
        observed: { kind: "backlog_drain", verified: false, depth: null },
      },
    }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    await runWatchTick(
      payloadFor(13),
      deps({ store, fetch, deliver, reschedule, now: new Date("2026-01-01T13:30:00.000Z") })
    );

    expect(calls.transition[0]).toMatchObject({
      resolution: "window_completed",
      observedOutcome: { kind: "backlog_drain", verified: false },
    });
    expect(appends[0]?.action.facts).toMatchObject({
      verified: false,
      reason: "unverified_at_expiry",
    });
  });
});

describe("runWatchBatchTick", () => {
  const ENVIRONMENT = "env_1";
  const CADENCE = 5;

  function batchPayload(
    tick: number,
    overrides: Partial<WatchBatchTickPayload> = {}
  ): WatchBatchTickPayload {
    return {
      environmentId: ENVIRONMENT,
      cadenceMinutes: CADENCE,
      apiOrigin: "http://localhost:3030",
      token: "batch_token",
      epoch: 3,
      tick,
      ...overrides,
    };
  }

  function group(count: number, overrides: Partial<Watch> = {}): Watch[] {
    return Array.from({ length: count }, (_, index) =>
      watchRow({
        id: `watch_${index + 1}`,
        chatId: `chat_${index + 1}`,
        environmentId: ENVIRONMENT,
        spec: { ...watchRow().spec, checkEveryMinutes: CADENCE } as Watch["spec"],
        ...overrides,
      })
    );
  }

  function entry(
    watch: Watch,
    overrides: Partial<WatchBatchCheckEntry> = {}
  ): WatchBatchCheckEntry {
    return {
      watchId: watch.id,
      token: `token_${watch.id}`,
      tick: watch.tickCount + 1,
      result: "satisfied",
      ...overrides,
    };
  }

  function batchDeps(parts: {
    store: WatchTickStore;
    response: WatchBatchCheckResponse | (() => Promise<WatchBatchCheckResponse>);
    deliver: WatchBatchTickDeps["deliver"];
    notifyFired?: WatchBatchTickDeps["notifyFired"];
    reschedule?: WatchBatchTickDeps["reschedule"];
    now?: Date;
  }): WatchBatchTickDeps {
    return {
      store: parts.store,
      checkBatch: async () =>
        typeof parts.response === "function" ? parts.response() : parts.response,
      deliver: parts.deliver,
      notifyFired: parts.notifyFired ?? (async () => {}),
      notifyInvestigate: async () => {},
      reschedule: parts.reschedule ?? (async () => {}),
      now: () => parts.now ?? NOW,
    };
  }

  it("resolves every watch of the group from ONE check call, and reschedules once", async () => {
    const rows = group(3);
    const { store, calls } = fakeStore(rows[0]!, rows[1]!, rows[2]!);
    const { appends, deliver } = fakeDeliver();
    const triggers: Array<{ payload: WatchBatchTickPayload; options: Record<string, unknown> }> =
      [];
    let checkCalls = 0;

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: async () => {
          checkCalls++;
          return { watches: rows.map((row) => entry(row)), continues: true };
        },
        deliver,
        reschedule: async (payload, options) => void triggers.push({ payload, options }),
      })
    );

    expect(checkCalls).toBe(1);
    expect(result.outcome).toBe("ticked");
    expect(result.results.map((one) => one.outcome)).toEqual(["fired", "fired", "fired"]);
    expect(appends.map((append) => append.chatId)).toEqual(["chat_1", "chat_2", "chat_3"]);
    expect(calls.delivered).toHaveLength(3);
    expect(rows.map((row) => row.status)).toEqual(["fired", "fired", "fired"]);

    expect(result.rescheduled).toBe(true);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.payload).toEqual(batchPayload(8));
    expect(triggers[0]?.options).toEqual({
      delay: "5m",
      idempotencyKey: "watch-batch:env_1:5:3:tick:8",
    });
  });

  it("one watch failing costs only that watch, and the chain still ticks on", async () => {
    const rows = group(3);
    const { store } = fakeStore(rows[0]!, rows[1]!, rows[2]!);
    const appends: string[] = [];
    const triggers: unknown[] = [];

    const batch = batchDeps({
      store,
      response: { watches: rows.map((row) => entry(row)), continues: true },
      deliver: async ({ chatId }) => {
        if (chatId === "chat_2") throw new Error("session append failed");
        appends.push(chatId);
      },
      reschedule: async (payload, options) => void triggers.push({ payload, options }),
    });

    await expect(runWatchBatchTick(batchPayload(7), batch)).rejects.toThrow(
      "1 of 3 watches failed their tick"
    );

    expect(appends).toEqual(["chat_1", "chat_3"]);
    expect(rows[0]).toMatchObject({ status: "fired", deliveryStatus: "delivered" });
    expect(rows[2]).toMatchObject({ status: "fired", deliveryStatus: "delivered" });

    expect(rows[1]).toMatchObject({ status: "fired", deliveryStatus: "pending" });

    expect(triggers).toHaveLength(1);
  });

  it("a watch whose wake is owed is redelivered by the group's own tick", async () => {
    const [owed] = group(1, {
      status: "fired",
      deliveryStatus: "pending",
      firedAt: NOW,
      lastResult: { runs: 2 },
    });
    const { store, calls } = fakeStore(owed!);
    const { appends, deliver } = fakeDeliver();

    const result = await runWatchBatchTick(
      batchPayload(8),
      batchDeps({
        store,
        response: {
          watches: [{ watchId: owed!.id, token: "t", tick: 0, deliverOnly: true }],
          continues: true,
        },
        deliver,
      })
    );

    expect(result.results).toEqual([{ watchId: "watch_1", outcome: "delivered_only" }]);
    expect(calls.claims).toHaveLength(0);
    expect(calls.transition).toHaveLength(0);
    expect(appends).toHaveLength(1);
    expect(owed!.deliveryStatus).toBe("delivered");
  });

  it("evaluates the window boundary inside the batch: a pending final check expires the watch", async () => {
    const rows = group(2);
    rows[0]!.expiresAt = new Date(NOW.getTime() - 1000);
    const { store, calls } = fakeStore(rows[0]!, rows[1]!);
    const { appends, deliver } = fakeDeliver();

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: {
          watches: [
            entry(rows[0]!, { result: "pending", facts: { pending: 7 } }),
            entry(rows[1]!, { result: "pending" }),
          ],
          continues: true,
        },
        deliver,
      })
    );

    expect(result.results.map((one) => one.outcome)).toEqual(["expired", "pending"]);
    expect(rows[0]?.status).toBe("expired");
    expect(rows[1]?.status).toBe("active");
    expect(calls.transition).toHaveLength(1);
    expect(calls.transition[0]).toMatchObject({ resolution: "window_completed" });
    expect(appends[0]?.action.facts).toMatchObject({
      verified: true,
      reason: "not_met_by_expiry",
      pending: 7,
    });
  });

  it("a boundary check that is satisfied still fires, inside a batch too", async () => {
    const [watch] = group(1);
    watch!.expiresAt = new Date(NOW.getTime() - 1000);
    const { store, calls } = fakeStore(watch!);
    const { appends, deliver } = fakeDeliver();

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: { watches: [entry(watch!, { facts: { pending: 0 } })], continues: true },
        deliver,
      })
    );

    expect(result.results[0]?.outcome).toBe("fired");
    expect(calls.transition[0]).toMatchObject({ resolution: "condition_met" });
    expect(appends[0]?.action.type).toBe("watch.fired");
  });

  it("two overlapping batch runs wake each chat exactly once", async () => {
    const rows = group(2);
    const { store, calls } = fakeStore(rows[0]!, rows[1]!);
    const { appends, deliver } = fakeDeliver();
    const fired: string[] = [];
    const batch = batchDeps({
      store,
      response: { watches: rows.map((row) => entry(row)), continues: true },
      deliver,
      notifyFired: async ({ watchId }) => void fired.push(watchId),
    });

    const [first, second] = await Promise.all([
      runWatchBatchTick(batchPayload(7), batch),
      runWatchBatchTick(batchPayload(7), batch),
    ]);

    expect(calls.deliveryClaims).toHaveLength(4);
    expect(calls.transition).toHaveLength(4);
    expect(appends.map((append) => append.chatId).sort()).toEqual(["chat_1", "chat_2"]);
    expect(calls.delivered).toHaveLength(2);
    expect(fired.sort()).toEqual(["watch_1", "watch_2"]);
    expect(rows.map((row) => row.deliveryStatus)).toEqual(["delivered", "delivered"]);

    const outcomes = [...first!.results, ...second!.results].map((one) => one.outcome);
    expect(outcomes.filter((outcome) => outcome === "fired")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "already_delivering")).toHaveLength(2);
  });

  it("a stale run owns nothing: no checks, no wakes, no reschedule", async () => {
    const rows = group(2);
    const { store, calls } = fakeStore(rows[0]!, rows[1]!);
    const { appends, deliver } = fakeDeliver();
    const triggers: unknown[] = [];

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: { stale: true },
        deliver,
        reschedule: async () => void triggers.push(1),
      })
    );

    expect(result).toEqual({ outcome: "stale", results: [], rescheduled: false });
    expect(calls.claims).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(triggers).toHaveLength(0);
    expect(rows.map((row) => row.status)).toEqual(["active", "active"]);
  });

  it("stops the chain when the group has nothing left to watch", async () => {
    const [watch] = group(1);
    const { store } = fakeStore(watch!);
    const { deliver } = fakeDeliver();
    const triggers: unknown[] = [];

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: { watches: [entry(watch!)], continues: false },
        deliver,
        reschedule: async () => void triggers.push(1),
      })
    );

    expect(result.rescheduled).toBe(false);
    expect(triggers).toHaveLength(0);
    expect(watch!.status).toBe("fired");
  });

  it("a revoked watch inside a batch is skipped, and its neighbours are not", async () => {
    const rows = group(2);
    const { store, calls } = fakeStore(rows[0]!, rows[1]!);
    const { appends, deliver } = fakeDeliver();

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: {
          watches: [
            { ...entry(rows[0]!), result: undefined, code: "access_revoked" },
            entry(rows[1]!),
          ],
          continues: true,
        },
        deliver,
      })
    );

    expect(result.results.map((one) => one.outcome)).toEqual(["revoked", "fired"]);
    expect(calls.transition).toHaveLength(1);
    expect(appends.map((append) => append.chatId)).toEqual(["chat_2"]);
  });

  it("a batch check that can't be read keeps the chain alive, and records nothing", async () => {
    const rows = group(2, { tickCount: 6, lastCheckedAt: NOW, lastResult: { runs: 1 } });
    const { store, calls } = fakeStore(rows[0]!, rows[1]!);
    const { appends, deliver } = fakeDeliver();
    const triggers: Array<{ payload: WatchBatchTickPayload; options: Record<string, unknown> }> =
      [];

    const result = await runWatchBatchTick(
      batchPayload(7),
      batchDeps({
        store,
        response: async () => {
          throw new Error("the batch check returned 401");
        },
        deliver,
        reschedule: async (payload, options) => void triggers.push({ payload, options }),
      })
    );

    expect(result).toEqual({ outcome: "unavailable", results: [], rescheduled: true });

    // Nothing was looked at, so the streak and the last-checked time stand.
    expect(calls.checks).toHaveLength(0);
    expect(calls.claims).toHaveLength(0);
    expect(appends).toHaveLength(0);
    expect(rows.map((row) => row.status)).toEqual(["active", "active"]);
    expect(rows.map((row) => row.tickCount)).toEqual([6, 6]);
    expect(rows.map((row) => row.lastCheckedAt)).toEqual([NOW, NOW]);

    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.payload).toEqual(batchPayload(8));
    // The same key the healthy path uses, so a retried tick can't fork the chain.
    expect(triggers[0]?.options).toEqual({
      delay: "5m",
      idempotencyKey: "watch-batch:env_1:5:3:tick:8",
    });
  });
});

describe("the hand-off to a batch chain", () => {
  it("a pending check that reports a chain stops rescheduling the per-watch tick", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "pending", batched: true } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(4), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "handed_off", tickCount: 4 });
    expect(calls.checks).toHaveLength(1);
    expect(triggers).toHaveLength(0);
    expect(row.status).toBe("active");
    expect(appends).toHaveLength(0);
  });

  it("a failed check that reports a chain hands over too", async () => {
    const { store, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({
      status: 503,
      body: { error: "clickhouse is down", batched: true },
    }));
    const { deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(4), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "handed_off", tickCount: 4 });
    expect(triggers).toHaveLength(0);
    expect(row.lastResult).toMatchObject({ checkFailed: true });
  });

  it("keeps its own chain when no chain is polling the group yet", async () => {
    const { store } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "pending", batched: false } }));
    const { deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(4), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "pending", tickCount: 4 });
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:5");
  });

  it("resolves as usual even when the answer reports a chain", async () => {
    const { store, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", batched: true } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();

    const result = await runWatchTick(PAYLOAD, deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "fired" });
    expect(row.status).toBe("fired");
    expect(appends).toHaveLength(1);
  });
});

describe("the wake's delivery acknowledgement", () => {
  it("leaves the wake owed when the append isn't acknowledged, and delivers it on the retry", async () => {
    const { store, calls, row } = fakeStore(watchRow());
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied" } }));
    const { reschedule } = fakeReschedule();

    await expect(
      runWatchTick(
        PAYLOAD,
        deps({ store, fetch, reschedule, deliver: async () => ({ appended: false }) })
      )
    ).rejects.toThrow(/wasn't appended/);

    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("pending");
    expect(calls.delivered).toHaveLength(0);
    expect(calls.released).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);

    const { appends, deliver } = fakeDeliver();
    const retry = await runWatchTick(PAYLOAD, deps({ store, fetch, reschedule, deliver }));

    expect(retry).toEqual({ outcome: "delivered_only" });
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });
});
