import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "prom-client";
import type { ColdStartState } from "../workloadManager/runCrd.js";
import {
  ColdStartHeartbeats,
  heartbeatRejected,
  type ColdStartBeatResult,
  type ColdStartTarget,
} from "./coldStartHeartbeats.js";

const INTERVAL_MS = 20_000;
const TIMEOUT_MS = 21 * 60_000;

const target: ColdStartTarget = {
  runFriendlyId: "run_a",
  snapshotFriendlyId: "snapshot_1",
  runnerId: "runner-a",
};

function setup() {
  // "hang" is a read that never settles.
  const state: { runner: ColdStartState | Error | "hang"; beat: ColdStartBeatResult } = {
    runner: "starting",
    beat: "ok",
  };
  const beats: ColdStartTarget[] = [];
  const reads: ColdStartTarget[] = [];
  const heartbeats = new ColdStartHeartbeats({
    readState: async (t) => {
      reads.push(t);
      if (state.runner === "hang") {
        return new Promise<never>(() => {});
      }
      if (state.runner instanceof Error) {
        throw state.runner;
      }
      return state.runner;
    },
    heartbeat: async (t) => {
      beats.push(t);
      return state.beat;
    },
    intervalMs: INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
    register: new Registry(),
  });
  return { heartbeats, state, beats, reads };
}

describe("ColdStartHeartbeats", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats the dequeued snapshot while the Runner waits for a node", async () => {
    // Catches: a run requeued as stalled while its Runner waits for a node.
    const { heartbeats, beats } = setup();

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4);

    expect(beats).toEqual([target, target, target, target]);
    expect(heartbeats.size).toBe(1);
    heartbeats.stop();
  });

  it("heartbeats before the create returns, without reading a Runner that may not exist yet", async () => {
    // Catches: a slow create leaving the run unheartbeated, or a read before the create ending it as gone.
    const { heartbeats, beats, reads } = setup();

    heartbeats.start(target);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(beats).toHaveLength(2);
    expect(reads).toHaveLength(0);
    heartbeats.stop();
  });

  it("stops once the Runner is running, so the runner's attempt start takes over", async () => {
    // Catches: the supervisor still heartbeating a run its runner has taken over, hiding a runner that stalls.
    const { heartbeats, state, beats } = setup();

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    state.runner = "started";
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(1);
    expect(heartbeats.size).toBe(0);
  });

  it("stops once the runner connects to this supervisor", async () => {
    // Catches: a heartbeat that outlives its runner's connection to this process.
    const { heartbeats, beats } = setup();

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    heartbeats.runnerConnected("run_a");
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(1);
    expect(heartbeats.size).toBe(0);
  });

  it("stops when the create fails", async () => {
    // Catches: a run whose create failed held back from requeue by heartbeats.
    const { heartbeats, beats } = setup();

    const heartbeat = heartbeats.start(target);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    heartbeat.createFailed();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(1);
    expect(heartbeats.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<ColdStartState>(["failed", "gone", "superseded"])(
    "stops when the Runner is %s, leaving the run to the stall timeout",
    async (runner) => {
      // Catches: a failed or replaced Runner's run held back from the stall requeue.
      const { heartbeats, state, beats } = setup();

      heartbeats.start(target).created();
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      state.runner = runner;
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

      expect(beats).toHaveLength(1);
      expect(heartbeats.size).toBe(0);
    }
  );

  it("keeps heartbeating through Runner read failures", async () => {
    // Catches: a Runner read outage stopping the heartbeat, so a healthy start is requeued.
    const { heartbeats, state, beats } = setup();
    state.runner = new Error("the API server is unavailable");

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(3);
    heartbeats.stop();
  });

  it("stops at its limit if the Runner never starts or fails", async () => {
    // Catches: a Runner that never starts or fails heartbeated without end.
    const { heartbeats, beats } = setup();

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const atLimit = beats.length;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(atLimit).toBe(TIMEOUT_MS / INTERVAL_MS - 1);
    expect(beats).toHaveLength(atLimit);
    expect(heartbeats.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops quietly when the platform refuses the heartbeat", async () => {
    // Catches: a refused heartbeat retried until the limit.
    const { heartbeats, state, beats } = setup();
    state.beat = "rejected";

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(1);
    expect(heartbeats.size).toBe(0);
  });

  it("keeps heartbeating after a heartbeat that failed in transit", async () => {
    // Catches: one transient heartbeat failure ending the heartbeat for good.
    const { heartbeats, state, beats } = setup();
    state.beat = "failed";

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(3);
    heartbeats.stop();
  });

  it("keeps one heartbeat per run, naming the snapshot dequeued last", async () => {
    // Catches: two deliveries of a run both heartbeated, one with a stale snapshot.
    const { heartbeats, beats } = setup();

    heartbeats.start(target).created();
    heartbeats.start({ ...target, snapshotFriendlyId: "snapshot_2" }).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(beats).toEqual([{ ...target, snapshotFriendlyId: "snapshot_2" }]);
    expect(heartbeats.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    heartbeats.stop();
  });

  it("keeps heartbeating on time while a Runner read hangs", async () => {
    // Catches: a hung Runner read holding back the heartbeat and the limit, or piling up reads.
    const { heartbeats, state, beats, reads } = setup();
    state.runner = "hang";

    heartbeats.start(target).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4 + INTERVAL_MS / 2);

    expect(beats).toHaveLength(4);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(heartbeats.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("beats an adopted cold start at once", async () => {
    // Catches: a restart leaving a gap long enough for the run to be requeued as stalled.
    const { heartbeats, beats } = setup();

    heartbeats.adopt(target, new Date());
    await vi.advanceTimersByTimeAsync(0);

    expect(beats).toEqual([target]);
    heartbeats.stop();
  });

  it("counts an adopted cold start's limit from the Runner's creation", async () => {
    // Catches: each restart granting a stuck Runner a fresh limit.
    const { heartbeats, beats } = setup();

    heartbeats.adopt(target, new Date(Date.now() - TIMEOUT_MS + INTERVAL_MS * 2));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4);

    expect(beats).toHaveLength(2);
    expect(heartbeats.size).toBe(0);
  });

  it("does not adopt a run it already heartbeats", async () => {
    // Catches: adoption swapping a newer delivery's snapshot for the one its Runner was created with.
    const { heartbeats, beats } = setup();

    heartbeats.start({ ...target, snapshotFriendlyId: "snapshot_2" }).created();
    heartbeats.adopt(target, new Date());
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(beats).toEqual([{ ...target, snapshotFriendlyId: "snapshot_2" }]);
    heartbeats.stop();
  });

  it("clears every timer on stop and starts none after", async () => {
    // Catches: timers left running after shutdown, or a create during shutdown starting one.
    const { heartbeats, beats } = setup();

    heartbeats.start(target).created();
    heartbeats.start({ ...target, runFriendlyId: "run_b", runnerId: "runner-b" }).created();
    heartbeats.stop();
    heartbeats.start({ ...target, runFriendlyId: "run_c", runnerId: "runner-c" }).created();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(beats).toHaveLength(0);
    expect(heartbeats.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("heartbeatRejected", () => {
  it.each([
    [400, true],
    [401, true],
    [404, true],
    [409, true],
    [408, false],
    [429, false],
    [500, false],
    [503, false],
    [undefined, false],
  ])("%s -> %s", (statusCode, rejected) => {
    // Catches: a timeout or rate limit taken as a refusal, ending the heartbeat on a transient error.
    expect(heartbeatRejected(statusCode)).toBe(rejected);
  });
});
