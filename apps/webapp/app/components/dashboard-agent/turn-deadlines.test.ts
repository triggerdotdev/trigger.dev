import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inFlightToolName } from "./progress-line";
import {
  activeToolPendingKey,
  createKeyedDeadline,
  turnDeadlineErrorMessage,
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

  it("clears a fired error once the key resolves — late recovery", async () => {
    const { deadline, timeouts, clears } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(timeouts).toEqual(["submitted"]);

    deadline.sync(null);
    expect(clears).toHaveLength(1);
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

  it("dispose stops the timer without calling onClear", async () => {
    const { deadline, timeouts, clears } = harness<"submitted">(45_000);

    deadline.sync("submitted");
    deadline.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(timeouts).toEqual([]);
    expect(clears).toEqual([]);
  });
});

describe("turnDeadlineErrorMessage", () => {
  const label = (tool: string) => (tool === "get_run" ? "Reading the run" : `Running ${tool}`);

  it("names the first-event case without a tool", () => {
    expect(turnDeadlineErrorMessage({ kind: "first-event" }, label)).toBe(
      "The agent hasn't started responding. It may not be running — try again."
    );
  });

  it("names the pending tool in the tool-pending case", () => {
    expect(turnDeadlineErrorMessage({ kind: "tool-pending", tool: "get_run" }, label)).toBe(
      "Reading the run is taking longer than expected. It may not be running — try again."
    );
  });
});

/**
 * `DashboardAgentChat`'s wiring reproduced with its own exported pieces (`activeToolPendingKey`,
 * `createKeyedDeadline`) instead of mounting the component — this repo has no DOM/render test
 * setup (see `wake-poll.test.ts` for the same pattern: the extracted logic is what's tested).
 */
describe("DashboardAgentChat wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const dangling = [
    { role: "assistant", parts: [{ type: "tool-get_run", state: "input-available" }] },
  ];

  it("never arms for a dangling tool part on an idle chat, and never errors", async () => {
    const { deadline, timeouts } = harness<string>(120_000);

    // Same call the component's effect makes every render: status is "ready" (idle),
    // not "streaming"/"submitted", so the key is gated to null despite the dangling part.
    deadline.sync(activeToolPendingKey("ready", inFlightToolName(dangling)));

    await vi.advanceTimersByTimeAsync(200_000);
    expect(timeouts).toEqual([]);
  });

  it("retry re-arms the deadline after it already fired on the same dangling part", async () => {
    const { deadline, timeouts } = harness<string>(120_000);

    deadline.sync(activeToolPendingKey("streaming", inFlightToolName(dangling)));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(timeouts).toEqual(["get_run"]);

    // Retry's explicit reset (DashboardAgentChat.tsx) before the retried turn's effect
    // re-syncs the same key — without it, `sync("get_run")` while still `currentKey`
    // would be a no-op and the deadline would never fire again.
    deadline.sync(null);
    deadline.sync(activeToolPendingKey("streaming", inFlightToolName(dangling)));

    await vi.advanceTimersByTimeAsync(120_000);
    expect(timeouts).toEqual(["get_run", "get_run"]);
  });
});
