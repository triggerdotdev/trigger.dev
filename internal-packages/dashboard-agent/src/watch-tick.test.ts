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

/** The payload for the generation an invocation owns. */
function payloadFor(tick: number): WatchTickPayload {
  return {
    watchId: "watch_1",
    token: "watch_token",
    apiOrigin: "http://localhost:3030",
    tick,
  };
}

/** The first generation, which the webapp schedules when it creates the watch. */
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
    organizationId: "org_1",
    projectId: "proj_1",
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

// A store over one row, guarded exactly like the real queries: the generation
// claim only lands on an `active` row still on the previous generation, the
// condition transition only applies to an `active` row, and the release / delivered
// marks only to the claim whose fencing token the row still carries.
function fakeStore(row: Watch) {
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
    getWatch: async () => ({ ...row }),
    claimWatchTick: async (params) => {
      calls.claims.push(params);
      if (row.status !== "active") return null;
      // Resumable, exactly like the real query: the previous generation (fresh) or
      // this one (a retry resuming its own generation), never one further ahead.
      if (row.tickCount !== params.generation - 1 && row.tickCount !== params.generation) {
        return null;
      }
      row.tickCount = params.generation;
      // Deliberately NOT lastCheckedAt: a claim is not an observation.
      return { ...row };
    },
    claimWatchDelivery: async (params) => {
      calls.deliveryClaims.push(params);
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
      // Same fence: a mark from a taken-over deliverer completes nothing.
      if (row.deliveryStatus !== "delivering" || row.deliveryClaimId !== params.claimId)
        return null;
      row.deliveryStatus = "delivered";
      row.deliveredAt = NOW;
      return { ...row };
    },
    recordWatchCheck: async (params) => {
      calls.checks.push(params);
      if (row.status !== "active") return null;
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
  it("pending: claims its generation, records the check, and reschedules the next generation", async () => {
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch, calls: fetchCalls } = fakeFetch(() => ({ body: { result: "pending" } }));
    const { appends, deliver } = fakeDeliver();
    const { triggers, reschedule } = fakeReschedule();

    const result = await runWatchTick(payloadFor(4), deps({ store, fetch, deliver, reschedule }));

    expect(result).toEqual({ outcome: "pending", tickCount: 4 });
    // The counter moved exactly once, in the claim.
    expect(calls.claims).toEqual([{ id: "watch_1", generation: 4 }]);
    expect(row.tickCount).toBe(4);
    // The check went to the watch's own endpoint with the watch token, and was
    // NOT flagged final (the watch has an hour left).
    expect(fetchCalls[0]?.url).toBe(
      "http://localhost:3030/api/v1/dashboard-agent/watches/watch_1/check"
    );
    expect(
      (fetchCalls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization
    ).toBe("Bearer watch_token");
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({});

    // The check result is recorded without touching the counter, and the successor
    // carries the next generation in both the payload and the key.
    expect(calls.checks).toEqual([{ id: "watch_1", lastResult: {} }]);
    expect(triggers).toEqual([
      {
        payload: payloadFor(5),
        options: { delay: "1m", idempotencyKey: "watch:watch_1:tick:5" },
      },
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
    // Delivery is marked only after the append, and under the claim's own token.
    expect(calls.delivered).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
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

    const result = await runWatchTick(payloadFor(2), deps({ store, fetch, deliver, reschedule }));

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

    // The row is terminal with the delivery still owed, and nothing was marked. The
    // failed append gave the claim back, so the retry doesn't have to wait it out.
    expect(row.status).toBe("fired");
    expect(row.deliveryStatus).toBe("pending");
    expect(calls.released).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
    expect(calls.delivered).toHaveLength(0);
    expect(appends).toHaveLength(0);

    // The retry takes the delivery-only path: no second transition, one append.
    const retry = await runWatchTick(PAYLOAD, d);
    expect(retry).toEqual({ outcome: "delivered_only" });
    expect(calls.transition).toHaveLength(1);
    expect(appends).toHaveLength(1);
    expect(row.deliveryStatus).toBe("delivered");
  });

  it("two concurrent invocations of the same generation wake the chat exactly once", async () => {
    // The tick claim is resumable, so two invocations that own the same generation
    // can both pass it, both see the condition satisfied, and both reach the
    // delivery — one as the transition's winner, the other finding terminal + owed.
    // Only the delivery claim keeps that from being two wakes.
    const { store, calls, row } = fakeStore(watchRow({ tickCount: 3 }));
    const { fetch } = fakeFetch(() => ({ body: { result: "satisfied", facts: { runs: 1 } } }));
    const { appends, deliver } = fakeDeliver();
    const { reschedule } = fakeReschedule();
    const { notified, notifyFired } = fakeNotifyFired();
    const d = deps({ store, fetch, deliver, reschedule, notifyFired });

    const outcomes = (
      await Promise.all([runWatchTick(payloadFor(4), d), runWatchTick(payloadFor(4), d)])
    ).map((result) => result.outcome);

    // BOTH reached the delivery — that is the race — and only one got the claim.
    expect(calls.deliveryClaims).toHaveLength(2);
    // ONE wake, one delivery mark, one alert.
    expect(appends).toHaveLength(1);
    expect(calls.delivered).toEqual([{ id: "watch_1", claimId: "wdc_1" }]);
    expect(notified).toEqual(["watch_1"]);
    // One of them resolved the row; the other found the delivery already taken.
    expect(calls.transition).toHaveLength(2);
    expect(outcomes).toContain("fired");
    expect(outcomes).toContain("already_delivering");
    expect(row).toMatchObject({ status: "fired", deliveryStatus: "delivered" });
  });

  it("a live delivery claim is left alone, and a dead one is recovered", async () => {
    // A deliverer that claimed the wake and died leaves the row `delivering`. While
    // the claim is fresh it is somebody's to hold; once it is stale nothing else
    // will ever wake the chat, so the next invocation takes it.
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
    // Still watching, and the last good observation is kept.
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:4");
    expect(row.lastResult).toMatchObject({ checkFailed: true, previous: { pending: 12 } });
  });

  it("access_revoked: exits without resolving, delivering, or rescheduling", async () => {
    // The endpoint cancelled the row itself before answering, so there is nothing
    // left for the tick to transition — and a cancellation is never narrated.
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
    // The chain stops here: the generation was claimed, and nothing follows it.
    expect(row.tickCount).toBe(1);
  });

  it("an unrecognized 403 is a failed check, not a silent exit: it reschedules", async () => {
    // Anything but access_revoked/cancelled/not_found leaves the row active, so it
    // must keep ticking (and hit its own deadline) rather than be abandoned.
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

    // Generation 4 is accepted and schedules 5, which then claims its own.
    expect(await runWatchTick(payloadFor(4), d)).toEqual({ outcome: "pending", tickCount: 4 });
    expect(await runWatchTick(payloadFor(5), d)).toEqual({ outcome: "pending", tickCount: 5 });

    // A duplicate of generation 4 arrives late — its successor has already run, so
    // it must not check, record, or start a second chain.
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

    // The first attempt claims generation 4, checks — and dies scheduling its
    // successor, so nobody has generation 5.
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

    // The platform retries the SAME generation. It has to be able to resume: the
    // row is already on 4, and refusing the claim would leave the chain with no
    // successor at all.
    const retry = await runWatchTick(payloadFor(4), d);

    expect(retry).toEqual({ outcome: "pending", tickCount: 4 });
    expect(calls.claims).toEqual([
      { id: "watch_1", generation: 4 },
      { id: "watch_1", generation: 4 },
    ]);
    expect(fetchCalls).toHaveLength(2);
    // One successor, and its key is a pure function of the generation — so the two
    // attempts can only ever produce the same one.
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.payload).toEqual(payloadFor(5));
    expect(triggers[0]?.options.idempotencyKey).toBe("watch:watch_1:tick:5");
    expect(row.status).toBe("active");
    expect(row.tickCount).toBe(4);
    expect(appends).toHaveLength(0);
  });

  it("a resumed generation past the deadline still resolves exactly once", async () => {
    // The resume re-runs the whole tick, including the terminal transition. The
    // guard on `active` is what makes that safe.
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

    // Past expiresAt (13:00) — the row is the authority, so this is the final check.
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
