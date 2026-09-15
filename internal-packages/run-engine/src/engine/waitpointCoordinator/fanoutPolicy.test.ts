// Pure logic, so no container: these are the decisions the worker and the coordinator make
// before they touch Redis. Every Redis-observable consequence of them is covered by
// fanoutWorker.test.ts against a real server.
import { describe, expect, it } from "vitest";
import {
  acknowledgeablePrefix,
  assertFanoutWorkerLimits,
  effectiveDeliveryConcurrency,
  completionFingerprint,
  DEFAULT_FANOUT_RETRY_POLICY,
  fanoutRetryDelayMs,
  isAcknowledgeable,
  type FanoutRetryPolicy,
  type FanoutWorkerLimits,
  type WatcherDeliveryOutcome,
} from "./fanoutPolicy.js";
import type { WaitpointCompletion } from "./storeCoordinator.js";

function completion(overrides: Partial<WaitpointCompletion> = {}): WaitpointCompletion {
  return {
    completedAt: "2026-08-21T12:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"ok":true}' },
    ...overrides,
  };
}

describe("completionFingerprint", () => {
  it("ignores completedAt, so a retry of the same completion matches", () => {
    expect(completionFingerprint(completion())).toBe(
      completionFingerprint(completion({ completedAt: "2027-01-01T00:00:00.000Z" }))
    );
  });

  it("is stable across calls", () => {
    expect(completionFingerprint(completion())).toBe(completionFingerprint(completion()));
  });

  it("separates a different inline output", () => {
    expect(completionFingerprint(completion())).not.toBe(
      completionFingerprint(completion({ output: { inline: '{"ok":false}' } }))
    );
  });

  it("separates a different output type", () => {
    expect(completionFingerprint(completion())).not.toBe(
      completionFingerprint(completion({ outputType: "text/plain" }))
    );
  });

  it("separates a success from an error carrying the same payload", () => {
    expect(completionFingerprint(completion())).not.toBe(
      completionFingerprint(completion({ outputIsError: true }))
    );
  });

  it("separates a null output from an inline empty string", () => {
    expect(completionFingerprint(completion({ output: null }))).not.toBe(
      completionFingerprint(completion({ output: { inline: "" } }))
    );
  });

  it("separates a ref from an inline value of the same text", () => {
    // The discriminator is in the digest, so an offloaded output is never mistaken for an
    // inline one that happens to read the same.
    expect(completionFingerprint(completion({ output: { ref: "s3://x" } }))).not.toBe(
      completionFingerprint(completion({ output: { inline: "s3://x" } }))
    );
  });
});

describe("fanoutRetryDelayMs", () => {
  const policy: FanoutRetryPolicy = { baseDelayMs: 100, maxDelayMs: 1_000, maxFailures: 5 };

  it("returns the base delay for the first attempt", () => {
    expect(fanoutRetryDelayMs(1, policy)).toBe(100);
  });

  it("treats a zero or negative attempt as the first", () => {
    expect(fanoutRetryDelayMs(0, policy)).toBe(100);
    expect(fanoutRetryDelayMs(-3, policy)).toBe(100);
  });

  it("doubles per attempt", () => {
    expect(fanoutRetryDelayMs(2, policy)).toBe(200);
    expect(fanoutRetryDelayMs(3, policy)).toBe(400);
    expect(fanoutRetryDelayMs(4, policy)).toBe(800);
  });

  it("caps at the ceiling", () => {
    expect(fanoutRetryDelayMs(5, policy)).toBe(1_000);
    expect(fanoutRetryDelayMs(50, policy)).toBe(1_000);
  });

  it("never exceeds the ceiling under the shipped defaults", () => {
    for (let attempt = 1; attempt <= DEFAULT_FANOUT_RETRY_POLICY.maxFailures; attempt++) {
      expect(fanoutRetryDelayMs(attempt, DEFAULT_FANOUT_RETRY_POLICY)).toBeLessThanOrEqual(
        DEFAULT_FANOUT_RETRY_POLICY.maxDelayMs
      );
    }
  });
});

// The give-up threshold itself is not a pure function any more: it has to be compared
// against inside wpFanoutRelease, atomically with the increment and the owner check. Its
// boundary is pinned against a real Redis in fanoutWorker.test.ts instead.

describe("isAcknowledgeable", () => {
  it("treats every terminal outcome as retirable", () => {
    const terminal: WatcherDeliveryOutcome[] = [
      "delivered",
      "duplicate",
      "stale-watcher",
      "rejected",
    ];
    for (const outcome of terminal) {
      expect(isAcknowledgeable(outcome)).toBe(true);
    }
  });

  it("holds a failure back", () => {
    expect(isAcknowledgeable("failed")).toBe(false);
  });
});

describe("acknowledgeablePrefix", () => {
  it("is zero for an empty page", () => {
    expect(acknowledgeablePrefix([])).toBe(0);
  });

  it("retires a fully successful page", () => {
    expect(acknowledgeablePrefix(["delivered", "duplicate", "rejected"])).toBe(3);
  });

  it("stops at the first failure and never skips past it", () => {
    // Skipping the failure would trim a watcher that was never delivered to — the lost
    // wake-up the head-only trim exists to prevent.
    expect(acknowledgeablePrefix(["delivered", "failed", "delivered"])).toBe(1);
  });

  it("retires nothing when the head failed", () => {
    expect(acknowledgeablePrefix(["failed", "delivered"])).toBe(0);
  });
});

describe("assertFanoutWorkerLimits", () => {
  const valid: FanoutWorkerLimits = {
    pageSize: 100,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxPagesPerVisit: 10,
    dueBatchSize: 50,
    deliveryConcurrency: 10,
    hintGraceMs: 5_000,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxFailures: 20,
  };

  it("accepts the shipped defaults", () => {
    expect(() => assertFanoutWorkerLimits(valid)).not.toThrow();
  });

  const positive: Array<keyof FanoutWorkerLimits> = [
    "pageSize",
    "leaseMs",
    "pollIntervalMs",
    "maxPagesPerVisit",
    "dueBatchSize",
    "deliveryConcurrency",
    "hintGraceMs",
    "baseDelayMs",
    "maxDelayMs",
    "maxFailures",
  ];

  // Zero is the interesting one: it does not throw anywhere by itself, it silently disables
  // whatever it bounds.
  for (const option of positive) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      it(`rejects ${option} = ${value}`, () => {
        expect(() => assertFanoutWorkerLimits({ ...valid, [option]: value })).toThrow(
          new RegExp(`${option} must be a positive safe integer`)
        );
      });
    }
  }

  it("rejects a ceiling below the base delay", () => {
    expect(() =>
      assertFanoutWorkerLimits({ ...valid, baseDelayMs: 5_000, maxDelayMs: 1_000 })
    ).toThrow(/maxDelayMs \(1000\) must be >= baseDelayMs \(5000\)/);
  });

  it("accepts a ceiling equal to the base delay", () => {
    expect(() =>
      assertFanoutWorkerLimits({ ...valid, baseDelayMs: 1_000, maxDelayMs: 1_000 })
    ).not.toThrow();
  });

  it("names the offending option, so the error is actionable", () => {
    expect(() => assertFanoutWorkerLimits({ ...valid, dueBatchSize: 0 })).toThrow(
      /WaitpointFanoutWorker: dueBatchSize/
    );
  });
});

/**
 * Ceilings, not just floors. A positive integer can still be a denial of service: `pageSize:
 * 1_000_000` is valid by the old rules and is also a million-element Redis reply parsed in one
 * synchronous burst.
 */
describe("assertFanoutWorkerLimits ceilings", () => {
  const base: FanoutWorkerLimits = {
    pageSize: 100,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxPagesPerVisit: 10,
    dueBatchSize: 50,
    deliveryConcurrency: 10,
    hintGraceMs: 5_000,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxFailures: 20,
  };

  const ceilings: Array<[keyof FanoutWorkerLimits, number]> = [
    ["pageSize", 1_000],
    ["dueBatchSize", 1_000],
    ["maxPagesPerVisit", 100],
    ["deliveryConcurrency", 100],
  ];

  for (const [option, maximum] of ceilings) {
    it(`accepts ${option} at its maximum of ${maximum}`, () => {
      // maxPagesPerVisit at its ceiling only fits under the per-visit budget with a small page,
      // so the page is shrunk here rather than the budget being relaxed.
      const at = { ...base, [option]: maximum };
      if (option === "maxPagesPerVisit") at.pageSize = 100;
      if (option === "pageSize") at.maxPagesPerVisit = 10;
      expect(() => assertFanoutWorkerLimits(at)).not.toThrow();
    });

    it(`rejects ${option} one above ${maximum}`, () => {
      expect(() => assertFanoutWorkerLimits({ ...base, [option]: maximum + 1 })).toThrow(
        new RegExp(`${option} must be <= ${maximum}`)
      );
    });
  }

  it("rejects a per-visit delivery budget above the aggregate ceiling", () => {
    // Both values are individually legal; multiplied they are 100,000 deliveries inside one
    // visit() call, which is the unbounded visit the aggregate bound exists to stop.
    expect(() =>
      assertFanoutWorkerLimits({ ...base, pageSize: 1_000, maxPagesPerVisit: 100 })
    ).toThrow(/pageSize \* maxPagesPerVisit \(100000\) must be <= 10000/);
  });

  it("accepts the largest per-visit budget", () => {
    expect(() =>
      assertFanoutWorkerLimits({ ...base, pageSize: 1_000, maxPagesPerVisit: 10 })
    ).not.toThrow();
  });

  // A small page with the default concurrency is a legitimate configuration: pMap clamps
  // in-flight work to the array it is given, so there is nothing to guard against here.
  it("does not require deliveryConcurrency <= pageSize", () => {
    expect(() =>
      assertFanoutWorkerLimits({ ...base, pageSize: 3, deliveryConcurrency: 10 })
    ).not.toThrow();
  });
});

/**
 * The in-flight byte budget. ioredis buffers the completion once per concurrent command, so the
 * configured concurrency alone does not bound the burst.
 */
describe("effectiveDeliveryConcurrency", () => {
  const MAX_INLINE = 524_288;

  it("leaves a small completion at the configured concurrency", () => {
    // A few hundred bytes at concurrency 100 is well inside the budget.
    expect(effectiveDeliveryConcurrency(100, 400)).toBe(100);
    expect(effectiveDeliveryConcurrency(10, 400)).toBe(10);
  });

  it("leaves a { ref } completion at the configured concurrency", () => {
    // The measured ref envelope was 150 bytes.
    expect(effectiveDeliveryConcurrency(100, 150)).toBe(100);
  });

  it("narrows a maximum-sized inline completion to the byte budget", () => {
    // 8 MiB / 512 KiB = 16, whatever the option says.
    expect(effectiveDeliveryConcurrency(100, MAX_INLINE)).toBe(16);
    expect(effectiveDeliveryConcurrency(50, MAX_INLINE)).toBe(16);
  });

  it("never RAISES the configured concurrency", () => {
    // The option stays an upper bound: a tiny completion does not licence more in flight.
    expect(effectiveDeliveryConcurrency(4, 10)).toBe(4);
  });

  it("never drops below one delivery", () => {
    // A single delivery must always be able to proceed, however big its envelope.
    expect(effectiveDeliveryConcurrency(100, 64 * 1024 * 1024)).toBe(1);
  });

  it("treats an empty envelope as unbudgeted", () => {
    // The FINISHED-healing shape encodes to "", which costs nothing per command.
    expect(effectiveDeliveryConcurrency(100, 0)).toBe(100);
  });
});
