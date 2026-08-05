import { describe, expect, it } from "vitest";
import {
  computeWaitingRunDiagnosis,
  DRAIN_ETA_TRUST,
  type WaitingRunDeps,
  type WaitingRunQueueSignals,
  type WaitingRunRow,
} from "~/presenters/v3/waitingRun/waitingRunDiagnosis";

const NOW = new Date("2026-07-27T12:00:00.000Z");

function run(overrides: Partial<WaitingRunRow> = {}): WaitingRunRow {
  return {
    friendlyId: "run_abc",
    status: "PENDING",
    queue: "task/my-task",
    concurrencyKey: null,
    createdAt: new Date(NOW.getTime() - 5 * 60_000),
    queuedAt: new Date(NOW.getTime() - 5 * 60_000),
    startedAt: null,
    delayUntil: null,
    ...overrides,
  };
}

/** A calm, healthy queue: steady depth, real dequeues, no throttling, capacity to spare. */
function signals(overrides: Partial<WaitingRunQueueSignals> = {}): WaitingRunQueueSignals {
  return {
    queueName: "task/my-task",
    windowMinutes: 15,
    sampleBuckets: 15,
    depthSeries: Array.from({ length: 15 }, () => 120),
    throttledSeries: Array.from({ length: 15 }, () => 0),
    startedCount: 300, // 20/min
    waitP50Ms: 1_200,
    waitP95Ms: 4_500,
    liveDepth: 120,
    envRunning: 4,
    envLimit: 100,
    queueRunning: 4,
    ...overrides,
  };
}

/** Plain fake readers; the repo forbids mocking frameworks. */
function deps(runRow: WaitingRunRow | null, queueSignals: WaitingRunQueueSignals | null) {
  const asked: string[] = [];
  const injected: WaitingRunDeps = {
    readRun: async () => runRow,
    readQueueSignals: async (queueName) => {
      asked.push(queueName);
      return queueSignals;
    },
  };
  return { injected, asked };
}

async function diagnose(
  runRow: WaitingRunRow | null,
  queueSignals: WaitingRunQueueSignals | null,
  now: Date = NOW
) {
  return computeWaitingRunDiagnosis(deps(runRow, queueSignals).injected, { now });
}

describe("computeWaitingRunDiagnosis", () => {
  it("returns null for an unknown run", async () => {
    expect(await diagnose(null, signals())).toBeNull();
  });

  it("never promises a per-run start time", async () => {
    const result = await diagnose(run(), signals());
    expect(result?.perRunStartEta).toEqual({
      supported: false,
      reason: "no-deterministic-position-source",
    });
  });

  it("reads the metrics for the run's own queue", async () => {
    const { injected, asked } = deps(run({ queue: "task/other" }), signals());
    await computeWaitingRunDiagnosis(injected, { now: NOW });
    expect(asked).toEqual(["task/other"]);
  });

  describe("queued run, queue draining healthily", () => {
    it("reports depth, delay, throughput, cause and a drain ETA", async () => {
      const result = await diagnose(run(), signals());

      expect(result?.run.waitingLabel).toBe("queued for 5m");
      expect(result?.run.waitingBasis).toBe("queued_at");
      expect(result?.run.isWaiting).toBe(true);
      expect(result?.run.queueWaitReliable).toBe(true);

      expect(result?.queue.depth).toBe(120);
      expect(result?.queue.depthSource).toBe("live_queue");
      expect(result?.queue.observedThroughputPerMin).toBe(20);
      expect(result?.queue.schedulingDelay).toEqual({ p50Ms: 1_200, p95Ms: 4_500 });

      expect(result?.diagnosis.cause).toBe("draining_normally");
      // 120 pending / 20 per minute
      expect(result?.drainEta).toEqual({ minutes: 6, basis: "observed_dequeue_rate" });
      expect(result?.drainEtaUnavailableReason).toBeNull();
    });

    it("uses the last measured bucket when the live counter is unavailable", async () => {
      const result = await diagnose(
        run(),
        signals({ liveDepth: null, depthSeries: [10, 20, 40, 60] })
      );
      expect(result?.queue.depth).toBe(60);
      expect(result?.queue.depthSource).toBe("queue_metrics");
    });

    it("measures a started run's wait as startedAt - queuedAt, not now - queuedAt", async () => {
      const result = await diagnose(
        run({
          status: "EXECUTING",
          queuedAt: new Date(NOW.getTime() - 10 * 60_000),
          startedAt: new Date(NOW.getTime() - 9 * 60_000),
        }),
        signals()
      );
      expect(result?.run.waitingLabel).toBe("queued for 1m");
      expect(result?.run.isWaiting).toBe(false);
    });

    it("flags a resumed run's stale queuedAt as unreliable", async () => {
      const result = await diagnose(run({ status: "WAITING_TO_RESUME" }), signals());
      expect(result?.run.queueWaitReliable).toBe(false);
    });
  });

  describe("throttled queue", () => {
    it("selects `throttled` when a quarter of the window throttled", async () => {
      // 5 of 15 buckets throttled = 0.33 share: past the throttled threshold (0.25), below the
      // sustained/pinned threshold (0.5).
      const throttledSeries = Array.from({ length: 15 }, (_, i) => (i < 5 ? 3 : 0));
      const result = await diagnose(run(), signals({ throttledSeries }));

      expect(result?.diagnosis.cause).toBe("throttled");
      expect(result?.queue.throttled.buckets).toBe(5);
      // A throttled queue still drains at its throttled rate, so the ETA stands.
      expect(result?.drainEta).toEqual({ minutes: 6, basis: "observed_dequeue_rate" });
    });

    it("selects `queue_limit_pinned` when throttling is sustained", async () => {
      const throttledSeries = Array.from({ length: 15 }, (_, i) => (i < 12 ? 3 : 0));
      const result = await diagnose(run(), signals({ throttledSeries }));
      expect(result?.diagnosis.cause).toBe("queue_limit_pinned");
      expect(result?.diagnosis.evidence.throttledShare).toBeCloseTo(0.8);
    });

    it("selects `env_limit_pinned` when the environment is at its limit", async () => {
      const result = await diagnose(run(), signals({ envRunning: 100, envLimit: 100 }));
      expect(result?.diagnosis.cause).toBe("env_limit_pinned");
      expect(result?.diagnosis.evidence.envRunningShare).toBe(1);
      expect(result?.drainEta).toEqual({ minutes: 6, basis: "observed_dequeue_rate" });
    });
  });

  describe("zero-throughput stall", () => {
    it("selects `stall` and refuses an ETA", async () => {
      const result = await diagnose(
        run(),
        signals({
          startedCount: 0,
          envRunning: 2, // 2% of a 100 limit — capacity is free but nothing is dequeuing
          depthSeries: [50, 80, 120, 200, 320],
          sampleBuckets: 5,
        })
      );

      expect(result?.diagnosis.cause).toBe("stall");
      expect(result?.diagnosis.evidence.backlogGrowing).toBe(true);
      expect(result?.queue.observedThroughputPerMin).toBe(0);
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("not_draining");
    });

    it("will not call it a stall without running-capacity evidence", async () => {
      const result = await diagnose(
        run(),
        signals({ startedCount: 0, envRunning: null, envLimit: null })
      );
      expect(result?.diagnosis.cause).toBe("unknown");
      expect(result?.diagnosis.evidence.missing).toBe("env_concurrency");
      expect(result?.drainEta).toBeNull();
    });
  });

  describe("labels that must never overclaim", () => {
    it("says a delayed run is scheduled, not queued", async () => {
      const delayUntil = new Date(NOW.getTime() + 30 * 60_000);
      const result = await diagnose(
        run({ status: "DELAYED", queuedAt: null, delayUntil }),
        signals()
      );

      expect(result?.run.waitingBasis).toBe("delay_until");
      expect(result?.run.waitingLabel).toBe(`scheduled to start at ${delayUntil.toISOString()}`);
      expect(result?.run.waitingLabel).not.toContain("queued for");
      expect(result?.run.queuedAt).toBeNull();
    });

    it("labels a createdAt fallback as time from creation", async () => {
      const result = await diagnose(
        run({
          status: "PENDING",
          queuedAt: null,
          delayUntil: null,
          createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000),
        }),
        signals()
      );

      expect(result?.run.waitingBasis).toBe("created_at");
      expect(result?.run.waitingLabel).toBe("time from creation: 2h");
      expect(result?.run.waitingLabel).not.toContain("queued");
      expect(result?.run.queueWaitReliable).toBe(false);
    });

    it("does not treat an elapsed delay as a schedule", async () => {
      const result = await diagnose(
        run({ status: "PENDING", queuedAt: null, delayUntil: new Date(NOW.getTime() - 60_000) }),
        signals()
      );
      // The delay passed but the run wasn't enqueued, so the label says the delay elapsed
      // rather than hiding it behind "time from creation".
      expect(result?.run.waitingBasis).toBe("delay_until");
      expect(result?.run.waitingLabel).toContain("not yet enqueued");
    });
  });

  describe("drain ETA trust conditions", () => {
    it("suppresses the ETA on too few sample buckets", async () => {
      const result = await diagnose(
        run(),
        signals({ sampleBuckets: DRAIN_ETA_TRUST.minSampleBuckets - 1 })
      );
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("insufficient_sample");
    });

    it("suppresses the ETA on too few observed dequeues", async () => {
      const result = await diagnose(
        run(),
        signals({ startedCount: DRAIN_ETA_TRUST.minStartedCount - 1 })
      );
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("insufficient_sample");
    });

    it("suppresses the ETA when the rate is unmeasured", async () => {
      const result = await diagnose(run(), signals({ startedCount: null }));
      expect(result?.queue.observedThroughputPerMin).toBeNull();
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("no_observed_rate");
    });

    it("reports no backlog rather than a zero ETA", async () => {
      const result = await diagnose(run(), signals({ liveDepth: 0, depthSeries: [0, 0, 0] }));
      expect(result?.diagnosis.cause).toBe("draining_normally");
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("no_backlog");
    });

    it("rounds a sub-minute drain up to one minute", async () => {
      const result = await diagnose(run(), signals({ liveDepth: 3 }));
      expect(result?.drainEta).toEqual({ minutes: 1, basis: "observed_dequeue_rate" });
    });
  });

  describe("no queue signals at all", () => {
    it("still answers, with an unknown cause and no ETA", async () => {
      const result = await diagnose(run(), null);

      expect(result?.run.waitingLabel).toBe("queued for 5m");
      expect(result?.queue.depth).toBeNull();
      expect(result?.queue.depthSource).toBe("unavailable");
      expect(result?.queue.observedThroughputPerMin).toBeNull();
      expect(result?.diagnosis.cause).toBe("unknown");
      expect(result?.diagnosis.evidence.missing).toBe("queue_signals");
      expect(result?.drainEta).toBeNull();
      expect(result?.drainEtaUnavailableReason).toBe("no_signals");
      expect(result?.perRunStartEta.supported).toBe(false);
    });
  });
});
