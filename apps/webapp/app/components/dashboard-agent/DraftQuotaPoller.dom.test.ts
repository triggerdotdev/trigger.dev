// @vitest-environment jsdom
import { createElement, useCallback, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftQuotaPoller } from "./DraftQuotaPoller";
import { shouldClearCapReached, type MessageQuota } from "./message-quota";
import { useAgentMessageQuota } from "./useAgentMessageQuota";

// Wired-up billing either way; the tier is per test, because routine polling is free-plan-only
// while the server can refuse any plan.
const plan = vi.hoisted(() => ({ isPaying: false }));
vi.mock("~/routes/_app.orgs.$organizationSlug/route", () => ({
  useCurrentPlan: () => ({ v3Subscription: { isPaying: plan.isPaying } }),
}));

/**
 * The panel's own wiring: a refused `create` bumps the generation and latches the cap with no
 * active chat, so the draft renders and this poller is the only quota reader mounted. Mounting
 * it only while capped, and the clearing rule, mirror `DashboardAgentPanel`.
 */
function Harness({
  refusalGenRef,
  capReachedAtStart,
  onCapped,
}: {
  refusalGenRef: MutableRefObject<number>;
  capReachedAtStart: boolean;
  onCapped: (capped: boolean) => void;
}) {
  const [capReached, setCapReached] = useState(capReachedAtStart);
  const handleQuotaChange = useCallback(
    (quota: MessageQuota & { pollIsFresh: boolean; provenCapacity: boolean }) => {
      setCapReached((current) =>
        current && quota.pollIsFresh && shouldClearCapReached(quota) ? false : current
      );
    },
    []
  );
  onCapped(capReached);
  return capReached
    ? createElement(DraftQuotaPoller, {
        actionPath: "/action",
        refusalGenRef,
        onQuotaChange: handleQuotaChange,
      })
    : null;
}

/** The chat's call shape: no `alwaysPoll`, so the free-plan-only policy applies. */
function RoutineHarness({ refusalGenRef }: { refusalGenRef: MutableRefObject<number> }) {
  useAgentMessageQuota({ actionPath: "/action", chatId: "chat_1", status: "ready", refusalGenRef });
  return null;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let pendingFetch: ((body: unknown) => void) | undefined;
let fetchCalls: string[] = [];

beforeEach(() => {
  plan.isPaying = false;
  pendingFetch = undefined;
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    // Rejects on abort, like the real thing: the hook's deadline depends on it.
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      fetchCalls.push(url);
      return new Promise<Response>((resolve, reject) => {
        pendingFetch = (body) => resolve({ ok: true, json: async () => body } as Response);
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    })
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderHarness(props: {
  refusalGenRef: MutableRefObject<number>;
  capReachedAtStart: boolean;
  onCapped: (capped: boolean) => void;
}) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(createElement(Harness, props));
  });
}

function renderRoutineHarness(props: { refusalGenRef: MutableRefObject<number> }) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(createElement(RoutineHarness, props));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function resolvePendingFetch(body: unknown) {
  const resolve = pendingFetch;
  if (!resolve) throw new Error("no fetch in flight");
  pendingFetch = undefined;
  resolve(body);
  await flush();
}

describe("the quota poller behind the draft", () => {
  it("reads the quota with no chat mounted", () => {
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: () => {},
    });

    expect(fetchCalls).toEqual(["/action?quota=1"]);
  });

  it("reads nothing while the draft is not capped", () => {
    // An idle draft has no block to lift, so the GET would be pure noise.
    renderHarness({
      refusalGenRef: { current: 0 },
      capReachedAtStart: false,
      onCapped: () => {},
    });

    expect(fetchCalls).toEqual([]);
  });

  it("unblocks the composer once the server says the quota is off", async () => {
    // Control break: without this poller mounted nothing ever calls `handleQuotaChange`
    // while `active` is null, and the upgrade block outlives the switch flipping off.
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("unblocks the composer once a read proves capacity", async () => {
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 5, limit: 20 });

    expect(capped).toBe(false);
  });

  it("keeps the block when the read still shows the cap", async () => {
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 20, limit: 20 });

    expect(capped).toBe(true);
  });

  it("re-reads on the interval, so a switch flipped off after mount is still seen", async () => {
    // The whole point of the interval: the draft has no turn to settle, so without it the
    // mount read is the only one and this cap never lifts.
    vi.useFakeTimers();
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 20, limit: 20 });
    expect(capped).toBe(true);
    expect(fetchCalls).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchCalls).toHaveLength(2);
    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("reads a capped draft on a paid plan too, and clears on the quota being off", async () => {
    // The server resolves the cap from the org's billing limit, so a paid org can be refused.
    // Routine polling is free-plan-only, hence the poller's `alwaysPoll`.
    plan.isPaying = true;
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    expect(fetchCalls).toEqual(["/action?quota=1"]);

    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("clears a paid plan's block once a read proves capacity", async () => {
    // The server's limit with room under it, on a plan whose own quota model says `unlimited`.
    plan.isPaying = true;
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 10, limit: 500 });

    expect(capped).toBe(false);
  });

  it("leaves the chat's routine polling free-plan-only", async () => {
    // The chat's call shape (no `alwaysPoll`): a paid plan has no nudge to show, so an
    // uncapped chat must not issue quota GETs.
    plan.isPaying = true;
    renderRoutineHarness({ refusalGenRef: { current: 0 } });

    expect(fetchCalls).toEqual([]);
  });

  it("lets a read outlive the poll delay instead of aborting it", async () => {
    // Control break: pace the reads with a fixed `setInterval` and the 30s tick re-runs the
    // hook's effect, whose cleanup aborts this 45s read — under a persistently slow endpoint
    // no read ever lands and the block is permanent.
    vi.useFakeTimers();
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });

    // 30s in, still in flight: nothing was armed against it, so no second read either.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchCalls).toHaveLength(1);

    // It lands at 45s and is still the live read.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("retries after a hung read hits its deadline", async () => {
    // Control break: without the deadline counting as a settle, a request that never answers
    // arms no retry and the block outlives everything short of a remount.
    vi.useFakeTimers();
    let capped = true;
    renderHarness({
      refusalGenRef: { current: 1 },
      capReachedAtStart: true,
      onCapped: (v) => (capped = v),
    });
    expect(fetchCalls).toHaveLength(1);

    // Never answered. The 60s deadline aborts it and counts as a settle...
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchCalls).toHaveLength(1);

    // ...so the usual 30s gap arms the next read, which lands.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchCalls).toHaveLength(2);
    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("keeps the block for a read that started before a later refusal", async () => {
    // The panel's generation ordering, across the poller too: this poll captured generation 1,
    // a refusal bumps it to 2 while the read is in flight, so the read is stale on arrival.
    let capped = true;
    const refusalGenRef = { current: 1 };
    renderHarness({ refusalGenRef, capReachedAtStart: true, onCapped: (v) => (capped = v) });
    refusalGenRef.current += 1;
    await resolvePendingFetch({ used: 5, limit: 20 });

    expect(capped).toBe(true);
  });

  it("keeps a paid plan's block for a read that started before a later refusal", async () => {
    // The free-plan case above also holds on `kind` alone (a `within` read that isn't fresh is
    // still `within`). On a paid plan the read resolves to `unlimited` and only `provenCapacity`
    // would release it, so `pollIsFresh` is the one thing standing between a stale read and a
    // cap it must not lift — drop the `pollIsFresh &&` and only this fails.
    plan.isPaying = true;
    let capped = true;
    const refusalGenRef = { current: 1 };
    renderHarness({ refusalGenRef, capReachedAtStart: true, onCapped: (v) => (capped = v) });
    refusalGenRef.current += 1;
    await resolvePendingFetch({ used: 10, limit: 500 });

    expect(capped).toBe(true);
  });
});
