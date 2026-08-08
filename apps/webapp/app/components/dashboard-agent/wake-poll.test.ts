import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWakePolling, UNREAD_POLL_INTERVAL_MS, wakesToToast } from "./wake-poll";

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
