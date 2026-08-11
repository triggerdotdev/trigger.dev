import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWakePendingCount,
  planWakeToasts,
  startWakePolling,
  UNREAD_POLL_INTERVAL_MS,
  wakesToToast,
} from "./wake-poll";

function harness() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const loads: number[] = [];

  const stop = startWakePolling({
    load: async () => {
      loads.push(Date.now());
    },
    isHidden: () => hidden,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // No jitter, so every delay is exactly one interval.
    random: () => 0,
    setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
  });

  return {
    loads,
    stop,
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe("startWakePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls once immediately and then once per interval", async () => {
    const poll = harness();

    expect(poll.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS * 3);
    expect(poll.loads).toHaveLength(4);

    poll.stop();
  });

  it("asks nothing while hidden and catches up once when visible again", async () => {
    const poll = harness();
    poll.setHidden(true);

    await vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS * 3);
    expect(poll.loads).toHaveLength(1);

    poll.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll.loads).toHaveLength(2);

    poll.stop();
  });

  it("keeps exactly one chain across ten rapid hide/show cycles", async () => {
    const poll = harness();

    for (let cycle = 0; cycle < 10; cycle++) {
      poll.setHidden(true);
      await vi.advanceTimersByTimeAsync(10);
      poll.setHidden(false);
      await vi.advanceTimersByTimeAsync(10);
    }

    const afterCycles = poll.loads.length;
    await vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS * 10);

    // One poll per interval, not ten: the resumes replaced the chain instead of
    // forking it.
    expect(poll.loads.length - afterCycles).toBe(10);

    poll.stop();
  });

  it("stops every timer and listener on unmount", async () => {
    const poll = harness();
    poll.setHidden(true);
    poll.setHidden(false);

    poll.stop();
    const settled = poll.loads.length;

    await vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS * 10);
    expect(poll.loads).toHaveLength(settled);
    expect(poll.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("wakesToToast", () => {
  const wake = (watchId: string, unread: boolean) => ({ watchId, unread });

  it("skips a wake another machine already read, and keeps the unread one", () => {
    const wakes = [wake("watch_read", false), wake("watch_new", true)];

    expect(wakesToToast(wakes, new Set())).toEqual([wake("watch_new", true)]);
  });

  it("still skips what this browser toasted, read or not", () => {
    const wakes = [wake("watch_seen", true), wake("watch_new", true)];

    expect(wakesToToast(wakes, new Set(["watch_seen"]))).toEqual([wake("watch_new", true)]);
  });

  // The read POST is what clears it, and that only runs once the chat is looked at.
  it("toasts a wake that landed in an open chat, because it is still unread", () => {
    expect(wakesToToast([wake("watch_in_view", true)], new Set())).toHaveLength(1);
  });

  it("treats a wake with no unread flag as already seen rather than guessing", () => {
    expect(wakesToToast([{ watchId: "watch_old" }], new Set())).toEqual([]);
    expect(wakesToToast(undefined, new Set())).toEqual([]);
  });
});

describe("planWakeToasts", () => {
  const MAX = 3;
  const batch = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("toasts a small batch individually but still counts it toward the running total", () => {
    const { plan, pending } = planWakeToasts(batch(2), 0, MAX);

    expect(plan).toEqual({ mode: "individual", wakes: [0, 1] });
    expect(pending).toBe(2);
  });

  it("summarizes when a single batch is over the max", () => {
    const { plan, pending } = planWakeToasts(batch(4), 0, MAX);

    expect(plan).toEqual({ mode: "summary", count: 4 });
    expect(pending).toBe(4);
  });

  it("accumulates across consecutive polls instead of showing only the latest", () => {
    // First batch of 2 is below the max: individual toasts, nothing pending yet.
    const first = planWakeToasts(batch(2), 0, MAX);
    expect(first.plan.mode).toBe("individual");

    // A second batch of 3 pushes the running total to 5, so the grouped toast claims
    // the cumulative count, not just this batch's 3.
    const second = planWakeToasts(batch(3), first.pending, MAX);
    expect(second.plan).toEqual({ mode: "summary", count: 5 });
    expect(second.pending).toBe(5);
  });

  it("grows the visible summary as later batches arrive", () => {
    const first = planWakeToasts(batch(4), 0, MAX);
    const second = planWakeToasts(batch(3), first.pending, MAX);

    expect(second.plan).toEqual({ mode: "summary", count: 7 });
    expect(second.pending).toBe(7);
  });
});

describe("createWakePendingCount", () => {
  const MAX = 3;
  const batch = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("carries unacknowledged wakes into the summary", () => {
    const count = createWakePendingCount();

    expect(count.plan(batch(2), MAX)).toEqual({ mode: "individual", wakes: [0, 1] });
    expect(count.plan(batch(2), MAX)).toEqual({ mode: "summary", count: 4 });
  });

  it("does not count wakes the user already opened", () => {
    const count = createWakePendingCount();

    // Two individual toasts, both opened — from the toast, ⌘J, anywhere.
    expect(count.plan(batch(2), MAX).mode).toBe("individual");
    count.acknowledge();

    // Only the two new wakes are waiting, so they toast individually rather than
    // claiming "4 watch updates".
    expect(count.plan(batch(2), MAX)).toEqual({ mode: "individual", wakes: [0, 1] });
  });

  it("starts the next summary from the wakes that arrived after the open", () => {
    const count = createWakePendingCount();

    expect(count.plan(batch(4), MAX)).toEqual({ mode: "summary", count: 4 });
    count.acknowledge();

    expect(count.plan(batch(2), MAX).mode).toBe("individual");
    expect(count.plan(batch(2), MAX)).toEqual({ mode: "summary", count: 4 });
  });
});
