// @vitest-environment jsdom
import { createElement, useEffect, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldClearCapReached } from "./message-quota";
import { useAgentMessageQuota } from "./useAgentMessageQuota";

// A non-paying, wired-up plan: the hook only polls on the free plan.
vi.mock("~/routes/_app.orgs.$organizationSlug/route", () => ({
  useCurrentPlan: () => ({ v3Subscription: { isPaying: false } }),
}));

/**
 * Mirrors the real wiring: a refusal bumps a shared `refusalGenRef` (owned by the caller, as
 * DashboardAgentPanel owns it), and only a poll whose fetch started at that SAME generation
 * (`quota.pollIsFresh`) may clear the cap — no wall clock, so two events racing in the same
 * tick can't tie.
 */
function Harness({
  status,
  refusalGenRef,
  refuseSeq = 0,
  onCapped,
}: {
  status: string;
  refusalGenRef: MutableRefObject<number>;
  refuseSeq?: number;
  onCapped: (capped: boolean) => void;
}) {
  const quota = useAgentMessageQuota({
    actionPath: "/action",
    chatId: "chat_1",
    status,
    refusalGenRef,
  });
  const [reached, setReached] = useState(false);
  // Stands in for the transport's fetch handler bumping the ref and calling
  // `setQuotaReached(reached)` on a 403.
  useEffect(() => {
    if (refuseSeq > 0) {
      refusalGenRef.current += 1;
      setReached(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refuseSeq]);
  useEffect(() => {
    setReached((current) =>
      current && quota.pollIsFresh && shouldClearCapReached(quota) ? false : current
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quota.pollSeq]);
  onCapped(reached);
  return null;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let pendingFetch: ((body: unknown) => void) | undefined;

beforeEach(() => {
  pendingFetch = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pendingFetch = (body) => resolve({ ok: true, json: async () => body } as Response);
        })
    )
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

function renderHarness(props: {
  status: string;
  refusalGenRef: MutableRefObject<number>;
  refuseSeq?: number;
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Resolves whichever fetch is currently in flight, then flushes the resulting state update.
async function resolvePendingFetch(body: unknown) {
  const resolve = pendingFetch;
  if (!resolve) throw new Error("no fetch in flight");
  pendingFetch = undefined;
  resolve(body);
  await flush();
}

describe("clearing a stale cap-reached block", () => {
  it("stays capped while the poll still shows the limit reached", async () => {
    let capped = false;
    const refusalGenRef = { current: 0 };
    renderHarness({ status: "ready", refusalGenRef, refuseSeq: 1, onCapped: (v) => (capped = v) });
    await resolvePendingFetch({ used: 20, limit: 20 });
    expect(capped).toBe(true);
  });

  it("clears the cap once the server says the quota is off", async () => {
    let capped = false;
    const refusalGenRef = { current: 0 };
    renderHarness({
      status: "submitted",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 20, limit: 20 });
    expect(capped).toBe(true);

    // The switch flips off, and a turn settling re-triggers the poll — the same path a
    // real chat re-reads on. No further refusal, so this poll's captured generation still
    // matches the live one.
    renderHarness({
      status: "ready",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ enabled: false });

    expect(capped).toBe(false);
  });

  it("clears a cap latched between two identical `within` reads", async () => {
    // Control break: gate the clearing effect on `quota.kind`/`reason` alone (or drop the
    // `pollIsFresh` gate) and this fails — two `within` reads in a row have the same kind,
    // so the effect never re-fires and the cap stays latched even though the fresh read
    // proves capacity is there.
    let capped = false;
    const refusalGenRef = { current: 0 };
    renderHarness({ status: "submitted", refusalGenRef, onCapped: (v) => (capped = v) });
    await resolvePendingFetch({ used: 5, limit: 20 });
    expect(capped).toBe(false);

    // A send mid-turn is refused over the cap (a real 403 the poll hasn't caught up to yet).
    renderHarness({
      status: "submitted",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    expect(capped).toBe(true);

    // The turn settles: a fresh poll STARTS after the refusal (its capture reads the
    // already-bumped generation) and comes back `within` again — identical kind to the
    // read before it — but it must still release the block.
    renderHarness({
      status: "ready",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 5, limit: 20 });

    expect(capped).toBe(false);
  });

  it("clears the cap when a fresh poll starts right after the refusal, even in the same tick", async () => {
    // No `Date.now()`/`performance.now()` involved: ordering is by generation, so a poll
    // whose capture happens in the very same synchronous tick as the refusal — as long as
    // it reads the ref AFTER the bump — still counts as fresh.
    let capped = false;
    const refusalGenRef = { current: 0 };
    // Refuse and (in the same render) settle the turn, which starts a brand new poll that
    // captures the just-bumped generation.
    renderHarness({
      status: "submitted",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    expect(capped).toBe(true);

    renderHarness({
      status: "ready",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    await resolvePendingFetch({ used: 5, limit: 20 });

    expect(capped).toBe(false);
  });

  it("keeps the cap when a poll that started before the refusal resolves after it", async () => {
    let capped = false;
    const refusalGenRef = { current: 0 };
    // This mount's poll captures generation 0 and is held pending (never resolved yet).
    renderHarness({ status: "submitted", refusalGenRef, onCapped: (v) => (capped = v) });
    expect(capped).toBe(false);

    // The refusal lands while that poll is still in flight, bumping the generation to 1.
    renderHarness({
      status: "submitted",
      refusalGenRef,
      refuseSeq: 1,
      onCapped: (v) => (capped = v),
    });
    expect(capped).toBe(true);

    // The stale poll — captured generation 0, before the refusal bumped it to 1 — now
    // resolves `within`. Its capture predates the refusal, so it must not lift the cap.
    await resolvePendingFetch({ used: 5, limit: 20 });

    expect(capped).toBe(true);
  });
});
