import { afterEach, describe, expect, it } from "vitest";
import {
  FirstSupportedReplicaLagSource,
  ReplicaLagEstimator,
  type ReplicaLagSource,
} from "~/services/realtime/replicaLagEstimator.server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function source(sampleLagMs: () => Promise<number | undefined>, name = "fake"): ReplicaLagSource {
  return { name, sampleLagMs };
}

describe("ReplicaLagEstimator", () => {
  let estimator: ReplicaLagEstimator | undefined;

  afterEach(() => {
    estimator?.stop();
    estimator = undefined;
  });

  it("returns the default before any sample lands", () => {
    estimator = new ReplicaLagEstimator({
      source: source(async () => undefined),
      defaultLagMs: 42,
    });
    expect(estimator.getLagMs()).toBe(42);
  });

  it("samples the source while touched and reports the window max", async () => {
    const samples = [10, 60, 20];
    let i = 0;
    estimator = new ReplicaLagEstimator({
      source: source(async () => samples[Math.min(i++, samples.length - 1)]),
      sampleIntervalMs: 10,
      windowMs: 5_000,
      defaultLagMs: 0,
    });
    estimator.touch();
    await sleep(60);
    // The max sample (60) dominates even after smaller ones land.
    expect(estimator.getLagMs()).toBe(60);
  });

  it("widens immediately on an observed (tripwire) lag and clamps wild values", () => {
    estimator = new ReplicaLagEstimator({
      source: source(async () => 5),
      defaultLagMs: 5,
      maxLagMs: 1_000,
    });
    estimator.noteObservedLagMs(250);
    expect(estimator.getLagMs()).toBe(250);
    estimator.noteObservedLagMs(99_999);
    expect(estimator.getLagMs()).toBe(1_000);
  });

  it("an observed lag floors the estimate past the sample window (until its TTL)", async () => {
    estimator = new ReplicaLagEstimator({
      source: source(async () => 0), // caught-up zeros, like vanilla PG between writes
      sampleIntervalMs: 10,
      windowMs: 30,
      defaultLagMs: 0,
      observedFloorTtlMs: 10_000,
    });
    estimator.touch();
    estimator.noteObservedLagMs(150);
    // Long past windowMs the zeros have flushed the observation out of the window,
    // but the floor still carries it.
    await sleep(80);
    expect(estimator.getLagMs()).toBe(150);
  });

  it("stops sampling once idle and resumes on touch", async () => {
    let probes = 0;
    estimator = new ReplicaLagEstimator({
      source: source(async () => {
        probes++;
        return 1;
      }),
      sampleIntervalMs: 10,
      idleAfterMs: 20,
    });
    estimator.touch();
    await sleep(80);
    const afterIdle = probes;
    expect(afterIdle).toBeGreaterThan(0);
    await sleep(40);
    // No new samples while idle...
    expect(probes).toBe(afterIdle);
    // ...and touching resumes immediately.
    estimator.touch();
    await sleep(15);
    expect(probes).toBeGreaterThan(afterIdle);
  });

  it("survives a throwing source and keeps the last known value", async () => {
    let fail = false;
    estimator = new ReplicaLagEstimator({
      source: source(async () => {
        if (fail) throw new Error("source down");
        return 33;
      }),
      sampleIntervalMs: 10,
      windowMs: 30,
      defaultLagMs: 0,
    });
    estimator.touch();
    await sleep(25);
    expect(estimator.getLagMs()).toBe(33);
    fail = true;
    await sleep(60);
    // Window emptied, source failing — falls back to the last known sample.
    expect(estimator.getLagMs()).toBe(33);
  });
});

describe("FirstSupportedReplicaLagSource", () => {
  it("selects the first candidate whose sample succeeds and sticks with it", async () => {
    let auroraCalls = 0;
    let vanillaCalls = 0;
    const composed = new FirstSupportedReplicaLagSource([
      source(async () => {
        auroraCalls++;
        throw new Error("function aurora_replica_status() does not exist");
      }, "aurora"),
      source(async () => {
        vanillaCalls++;
        return 7;
      }, "vanilla-pg"),
    ]);
    expect(composed.name).toBe("undetected");
    expect(await composed.sampleLagMs()).toBe(7);
    expect(composed.name).toBe("vanilla-pg");
    expect(await composed.sampleLagMs()).toBe(7);
    // The unsupported dialect was only probed during selection.
    expect(auroraCalls).toBe(1);
    expect(vanillaCalls).toBe(2);
  });

  it("degrades to never-measuring when no candidate works", async () => {
    const composed = new FirstSupportedReplicaLagSource([
      source(async () => {
        throw new Error("nope");
      }),
    ]);
    expect(await composed.sampleLagMs()).toBeUndefined();
    expect(await composed.sampleLagMs()).toBeUndefined();
  });

  it("a transient error after selection skips the sample without unselecting", async () => {
    let calls = 0;
    const composed = new FirstSupportedReplicaLagSource([
      source(async () => {
        calls++;
        if (calls === 2) throw new Error("transient");
        return 11;
      }, "flaky"),
    ]);
    expect(await composed.sampleLagMs()).toBe(11);
    expect(await composed.sampleLagMs()).toBeUndefined(); // transient error -> skipped sample
    expect(await composed.sampleLagMs()).toBe(11); // still selected
    expect(composed.name).toBe("flaky");
  });
});
