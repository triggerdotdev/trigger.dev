import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerWheel } from "./timerWheel.js";

describe("TimerWheel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches item after delay", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();
    wheel.submit("run-1", "snapshot-data");

    // Not yet
    vi.advanceTimersByTime(2900);
    expect(dispatched).toEqual([]);

    // After delay
    vi.advanceTimersByTime(200);
    expect(dispatched).toEqual(["run-1"]);

    wheel.stop();
  });

  it("cancels item before it fires", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();
    wheel.submit("run-1", "data");

    vi.advanceTimersByTime(1000);
    expect(wheel.cancel("run-1")).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(dispatched).toEqual([]);
    expect(wheel.size).toBe(0);

    wheel.stop();
  });

  it("cancel returns false for unknown key", () => {
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: () => {},
    });
    expect(wheel.cancel("nonexistent")).toBe(false);
  });

  it("deduplicates: resubmitting same key replaces the entry", () => {
    const dispatched: { key: string; data: string }[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push({ key: item.key, data: item.data }),
    });

    wheel.start();
    wheel.submit("run-1", "old-data");

    vi.advanceTimersByTime(1000);
    wheel.submit("run-1", "new-data");

    // Original would have fired at t=3000, but was replaced
    // New one fires at t=1000+3000=4000
    vi.advanceTimersByTime(2100);
    expect(dispatched).toEqual([]);

    vi.advanceTimersByTime(1000);
    expect(dispatched).toEqual([{ key: "run-1", data: "new-data" }]);

    wheel.stop();
  });

  it("handles many concurrent items", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();

    for (let i = 0; i < 1000; i++) {
      wheel.submit(`run-${i}`, `data-${i}`);
    }
    expect(wheel.size).toBe(1000);

    vi.advanceTimersByTime(3100);
    expect(dispatched.length).toBe(1000);
    expect(wheel.size).toBe(0);

    wheel.stop();
  });

  it("handles items submitted at different times", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();

    wheel.submit("run-1", "data");
    vi.advanceTimersByTime(1000);
    wheel.submit("run-2", "data");
    vi.advanceTimersByTime(1000);
    wheel.submit("run-3", "data");

    // t=2000: nothing yet
    expect(dispatched).toEqual([]);

    // t=3100: run-1 fires
    vi.advanceTimersByTime(1100);
    expect(dispatched).toEqual(["run-1"]);

    // t=4100: run-2 fires
    vi.advanceTimersByTime(1000);
    expect(dispatched).toEqual(["run-1", "run-2"]);

    // t=5100: run-3 fires
    vi.advanceTimersByTime(1000);
    expect(dispatched).toEqual(["run-1", "run-2", "run-3"]);

    wheel.stop();
  });

  it("setDelay changes delay for new items only", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();

    wheel.submit("run-1", "data"); // 3s delay

    vi.advanceTimersByTime(500);
    wheel.setDelay(1000);
    wheel.submit("run-2", "data"); // 1s delay

    // t=1500: run-2 should have fired (submitted at t=500 with 1s delay)
    vi.advanceTimersByTime(1100);
    expect(dispatched).toEqual(["run-2"]);

    // t=3100: run-1 fires at its original 3s delay
    vi.advanceTimersByTime(1500);
    expect(dispatched).toEqual(["run-2", "run-1"]);

    wheel.stop();
  });

  it("stop returns unprocessed items", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();
    wheel.submit("run-1", "data-1");
    wheel.submit("run-2", "data-2");
    wheel.submit("run-3", "data-3");

    const remaining = wheel.stop();
    expect(dispatched).toEqual([]);
    expect(wheel.size).toBe(0);
    expect(remaining.length).toBe(3);
    expect(remaining.map((r) => r.key).sort()).toEqual(["run-1", "run-2", "run-3"]);
    expect(remaining.find((r) => r.key === "run-1")?.data).toBe("data-1");
  });

  it("after stop, new submissions are silently dropped", () => {
    const dispatched: string[] = [];
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();
    wheel.stop();

    wheel.submit("run-late", "data");
    expect(dispatched).toEqual([]);
    expect(wheel.size).toBe(0);
  });

  it("tracks size correctly through submit/cancel/dispatch", () => {
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: () => {},
    });

    wheel.start();

    wheel.submit("a", "data");
    wheel.submit("b", "data");
    expect(wheel.size).toBe(2);

    wheel.cancel("a");
    expect(wheel.size).toBe(1);

    vi.advanceTimersByTime(3100);
    expect(wheel.size).toBe(0);

    wheel.stop();
  });

  it("clamps delay to valid range", () => {
    const dispatched: string[] = [];

    // Very small delay (should be at least 1 tick = 100ms)
    const wheel = new TimerWheel<string>({
      delayMs: 0,
      onExpire: (item) => dispatched.push(item.key),
    });

    wheel.start();
    wheel.submit("run-1", "data");

    vi.advanceTimersByTime(200);
    expect(dispatched).toEqual(["run-1"]);

    wheel.stop();
  });

  it("multiple cancel calls are safe", () => {
    const wheel = new TimerWheel<string>({
      delayMs: 3000,
      onExpire: () => {},
    });

    wheel.start();
    wheel.submit("run-1", "data");

    expect(wheel.cancel("run-1")).toBe(true);
    expect(wheel.cancel("run-1")).toBe(false);

    wheel.stop();
  });
});
