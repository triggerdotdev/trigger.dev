import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { earliestInFlightToolCall } from "./progress-line";
import {
  createKeyedDeadline,
  NO_FIRST_EVENT_DEADLINE_MS,
  noFirstEventKey,
  TOOL_HUNG_DEADLINE_MS,
} from "./turn-deadlines";

function harness<K extends string>(deadlineMs: number) {
  const timeouts: K[] = [];
  const clears: number[] = [];

  const deadline = createKeyedDeadline<K>({
    deadlineMs,
    onTimeout: (key) => timeouts.push(key),
    onClear: () => clears.push(clears.length),
    setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
  });

  return { deadline, timeouts, clears };
}

describe("createKeyedDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once the key has stayed active past the deadline", async () => {
    const { deadline, timeouts } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(44_999);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(timeouts).toEqual(["submitted"]);
  });

  it("clears when the key goes away before the deadline, and never fires", async () => {
    const { deadline, timeouts, clears } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(30_000);
    deadline.sync(null);
    expect(clears).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeouts).toEqual([]);
  });

  it("restarts the timer when the active key changes to a different one", async () => {
    const { deadline, timeouts, clears } = harness<string>(120_000);

    deadline.sync("get_run");
    await vi.advanceTimersByTimeAsync(119_000);
    deadline.sync("run_query");
    expect(clears).toHaveLength(1);

    // The old key's near-expired timer is gone; the new key gets a fresh window.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(118_000);
    expect(timeouts).toEqual(["run_query"]);
  });

  it("is a no-op when synced with the key already active", async () => {
    const { deadline, timeouts } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(20_000);
    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(20_000);
    // Had the second sync restarted the timer, this would still be short of 45s.
    expect(timeouts).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(timeouts).toEqual(["submitted"]);
  });

  it("reset stops the timer without calling onClear, and re-arms the same key", async () => {
    const { deadline, timeouts, clears } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    deadline.reset();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeouts).toEqual([]);
    expect(clears).toEqual([]);

    // A retry re-arms because reset forgot the key, so the same key is a fresh sync.
    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(timeouts).toEqual(["submitted"]);
  });
});

/**
 * `noFirstEventKey` is the exact function `DashboardAgentChat.tsx`'s status effect calls
 * to compute `noFirstEventDeadline`'s sync key, so driving the real `createKeyedDeadline`
 * with it exercises the production wiring, not a copy of it.
 */
describe("createKeyedDeadline driven by noFirstEventKey", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function noFirstEventHarness() {
    const timeouts: string[] = [];
    const clears: number[] = [];
    const deadline = createKeyedDeadline<"submitted">({
      deadlineMs: NO_FIRST_EVENT_DEADLINE_MS,
      onTimeout: (key) => timeouts.push(key),
      onClear: () => clears.push(clears.length),
      setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
      clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
    });
    return { deadline, timeouts, clears };
  }

  it("fires once the turn stays submitted for the full 45s with nothing streamed", async () => {
    const { deadline, timeouts } = noFirstEventHarness();
    deadline.sync(noFirstEventKey("submitted"));

    await vi.advanceTimersByTimeAsync(NO_FIRST_EVENT_DEADLINE_MS - 1);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(timeouts).toEqual(["submitted"]);
  });

  it("clears once the first stream event moves status off submitted", async () => {
    const { deadline, timeouts, clears } = noFirstEventHarness();
    deadline.sync(noFirstEventKey("submitted"));
    await vi.advanceTimersByTimeAsync(NO_FIRST_EVENT_DEADLINE_MS - 1_000);

    deadline.sync(noFirstEventKey("streaming"));
    expect(clears).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeouts).toEqual([]);
  });

  it('a retry\'s reset then resync re-arms the deadline even though status stays "submitted"', async () => {
    const { deadline, timeouts } = noFirstEventHarness();
    deadline.sync(noFirstEventKey("submitted"));
    await vi.advanceTimersByTimeAsync(NO_FIRST_EVENT_DEADLINE_MS);
    expect(timeouts).toEqual(["submitted"]);

    // Mirrors `onRetrySettled`: reset forgets the key, so the unchanged "submitted" status
    // is a fresh sync rather than the no-op a bare `sync` would be.
    deadline.reset();
    deadline.sync(noFirstEventKey("submitted"));

    await vi.advanceTimersByTimeAsync(NO_FIRST_EVENT_DEADLINE_MS - 1);
    expect(timeouts).toEqual(["submitted"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(timeouts).toEqual(["submitted", "submitted"]);
  });

  it("clears once the turn stops (status settles to ready)", async () => {
    const { deadline, timeouts } = noFirstEventHarness();
    deadline.sync(noFirstEventKey("submitted"));
    await vi.advanceTimersByTimeAsync(NO_FIRST_EVENT_DEADLINE_MS - 1_000);

    deadline.sync(noFirstEventKey("ready"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timeouts).toEqual([]);
  });
});

describe("createKeyedDeadline driven by earliestInFlightToolCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("isn't masked when a parallel sibling call settles first", async () => {
    const timeouts: string[] = [];
    const deadline = createKeyedDeadline<string>({
      deadlineMs: TOOL_HUNG_DEADLINE_MS,
      onTimeout: (key) => timeouts.push(key),
      onClear: () => {},
      setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
      clearTimer: (handle) => clearTimeout(handle as unknown as NodeJS.Timeout),
    });
    const pending = (name: string, id: string) => ({
      type: `tool-${name}`,
      state: "input-available",
      toolCallId: id,
    });
    const settled = (name: string, id: string) => ({
      type: `tool-${name}`,
      state: "output-available",
      toolCallId: id,
    });
    const assistant = (parts: unknown[]) => ({ role: "assistant", parts });

    // Both calls start together; get_run is the earliest and the one that actually hangs.
    const messages1 = [assistant([pending("get_run", "call_1"), pending("run_query", "call_2")])];
    deadline.sync(earliestInFlightToolCall(messages1)?.callId ?? null);
    await vi.advanceTimersByTimeAsync(100_000);

    // run_query settles well before the deadline; a name- or "last one" keyed deadline
    // would restart here. get_run's id is unchanged, so its clock keeps running.
    const messages2 = [assistant([pending("get_run", "call_1"), settled("run_query", "call_2")])];
    deadline.sync(earliestInFlightToolCall(messages2)?.callId ?? null);
    await vi.advanceTimersByTimeAsync(TOOL_HUNG_DEADLINE_MS - 100_000 - 1);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(timeouts).toEqual(["call_1"]);
    expect(earliestInFlightToolCall(messages2)?.name).toBe("get_run");
  });
});
