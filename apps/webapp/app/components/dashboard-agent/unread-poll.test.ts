import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUnreadPolling, UNREAD_POLL_INTERVAL_MS } from "./unread-poll";

function harness() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const loads: number[] = [];

  const stop = startUnreadPolling({
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

describe("startUnreadPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Catches: no initial poll, or polling that never repeats on the interval.
  it("polls once immediately and then once per interval", async () => {
    const poll = harness();

    expect(poll.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(UNREAD_POLL_INTERVAL_MS * 3);
    expect(poll.loads).toHaveLength(4);

    poll.stop();
  });

  // Catches: polling a hidden tab, or no catch-up poll when it becomes visible again.
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

  // Catches: rapid hide/show cycles forking extra poll chains.
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

  // Catches: timers or listeners left running after unmount.
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
