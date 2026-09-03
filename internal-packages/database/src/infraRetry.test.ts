import { describe, expect, it } from "vitest";
import { Prisma } from "../generated/prisma";
import { type RetryBudget } from "./transaction";
import { withInfraRetry } from "./infraRetry";

const options = { enabled: true, maxAttempts: 4, backoffMinMs: 0, backoffMaxMs: 0 };
const noSleep = () => Promise.resolve();
const retryable = () => true;

// A thunk that throws `error` for its first `failTimes` calls, then resolves.
function makeThunk(failTimes: number, error: unknown = new Error("infra"), value = "ok") {
  let calls = 0;
  return {
    run: async () => {
      calls++;
      if (calls <= failTimes) throw error;
      return value;
    },
    calls: () => calls,
  };
}

describe("withInfraRetry", () => {
  it("runs the thunk exactly once when disabled", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, { options: { ...options, enabled: false }, isRetryable: retryable })
    ).rejects.toThrow("infra");
    expect(t.calls()).toBe(1);
  });

  it("isEnabled() false gates off even when options.enabled is true", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, {
        options: { ...options, enabled: true },
        isEnabled: () => false,
        isRetryable: retryable,
        sleep: noSleep,
      })
    ).rejects.toThrow("infra");
    expect(t.calls()).toBe(1);
  });

  it("isEnabled() true enables retry even when options.enabled is false (async supported)", async () => {
    const t = makeThunk(2);
    const result = await withInfraRetry(t.run, {
      options: { ...options, enabled: false },
      isEnabled: async () => true,
      isRetryable: retryable,
      sleep: noSleep,
    });
    expect(result).toBe("ok");
    expect(t.calls()).toBe(3);
  });

  it("a throwing isEnabled() gate runs the op once and never propagates the gate error", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, {
        options: { ...options, enabled: true },
        isEnabled: () => {
          throw new Error("flag store is down");
        },
        isRetryable: retryable,
        sleep: noSleep,
      })
    ).rejects.toThrow("infra"); // the op's own error, not the gate error
    expect(t.calls()).toBe(1);
  });

  it("retries a retryable error until it succeeds", async () => {
    const t = makeThunk(2);
    const result = await withInfraRetry(t.run, { options, isRetryable: retryable, sleep: noSleep });
    expect(result).toBe("ok");
    expect(t.calls()).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    const t = makeThunk(Infinity, new Error("query bug"));
    await expect(
      withInfraRetry(t.run, { options, isRetryable: () => false, sleep: noSleep })
    ).rejects.toThrow("query bug");
    expect(t.calls()).toBe(1);
  });

  it("gives up after maxAttempts", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, { options, isRetryable: retryable, sleep: noSleep })
    ).rejects.toThrow("infra");
    expect(t.calls()).toBe(4);
  });

  it("stops retrying once the shared budget is exhausted", async () => {
    const t = makeThunk(Infinity);
    let tokens = 1;
    const budget: RetryBudget = {
      tryConsume: () => {
        if (tokens > 0) {
          tokens--;
          return true;
        }
        return false;
      },
    };
    await expect(
      withInfraRetry(t.run, { options, isRetryable: retryable, budget, sleep: noSleep })
    ).rejects.toThrow("infra");
    // first attempt + one budgeted retry, then the budget denies the next
    expect(t.calls()).toBe(2);
  });

  it("runs the thunk exactly once when maxAttempts <= 1", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, {
        options: { ...options, maxAttempts: 1 },
        isRetryable: retryable,
        sleep: noSleep,
      })
    ).rejects.toThrow("infra");
    expect(t.calls()).toBe(1);
  });

  it("runs the thunk once (never skipped, never unbounded) for a non-finite maxAttempts", async () => {
    for (const maxAttempts of [NaN, Infinity]) {
      const t = makeThunk(Infinity);
      await expect(
        withInfraRetry(t.run, {
          options: { ...options, maxAttempts },
          isRetryable: retryable,
          sleep: noSleep,
        })
      ).rejects.toThrow("infra");
      expect(t.calls()).toBe(1);
    }
  });

  it("floors a fractional maxAttempts to whole attempts", async () => {
    const t = makeThunk(Infinity);
    await expect(
      withInfraRetry(t.run, {
        options: { ...options, maxAttempts: 3.9 },
        isRetryable: retryable,
        sleep: noSleep,
      })
    ).rejects.toThrow("infra");
    expect(t.calls()).toBe(3);
  });

  it("defaults to isRetryableInfrastructureError when no isRetryable is provided", async () => {
    const infra = new Prisma.PrismaClientKnownRequestError("boom", {
      code: "P1001",
      clientVersion: "6.14.0",
    });
    const t = makeThunk(1, infra);
    // no isRetryable in the config — the module must default to the classifier
    const result = await withInfraRetry(t.run, { options, sleep: noSleep });
    expect(result).toBe("ok");
    expect(t.calls()).toBe(2);
  });

  it("with the default classifier, does not retry a real query error", async () => {
    const queryError = new Prisma.PrismaClientKnownRequestError("not found", {
      code: "P2025",
      clientVersion: "6.14.0",
    });
    const t = makeThunk(Infinity, queryError);
    await expect(withInfraRetry(t.run, { options, sleep: noSleep })).rejects.toBe(queryError);
    expect(t.calls()).toBe(1);
  });

  it("does not retry a permanent init failure, but retries a transient one", async () => {
    const authErr = new Prisma.PrismaClientInitializationError(
      "Authentication failed against database server",
      "6.14.0",
      "P1000"
    );
    const permanent = makeThunk(Infinity, authErr);
    await expect(withInfraRetry(permanent.run, { options, sleep: noSleep })).rejects.toBe(authErr);
    expect(permanent.calls()).toBe(1);

    const reachErr = new Prisma.PrismaClientInitializationError(
      "Can't reach database server at localhost:5432",
      "6.14.0",
      "P1001"
    );
    const transient = makeThunk(1, reachErr);
    const result = await withInfraRetry(transient.run, { options, sleep: noSleep });
    expect(result).toBe("ok");
    expect(transient.calls()).toBe(2);
  });

  it("never retries a Rust-engine panic", async () => {
    const panic = new Prisma.PrismaClientRustPanicError("engine panicked", "6.14.0");
    const t = makeThunk(Infinity, panic);
    await expect(withInfraRetry(t.run, { options, sleep: noSleep })).rejects.toBe(panic);
    expect(t.calls()).toBe(1);
  });

  it("retries an unknown-request error only when it carries a connectivity signal", async () => {
    const opaque = new Prisma.PrismaClientUnknownRequestError("unexpected engine failure", {
      clientVersion: "6.14.0",
    });
    const permanent = makeThunk(Infinity, opaque);
    await expect(withInfraRetry(permanent.run, { options, sleep: noSleep })).rejects.toBe(opaque);
    expect(permanent.calls()).toBe(1);

    const connErr = new Prisma.PrismaClientUnknownRequestError(
      "connection terminated unexpectedly",
      {
        clientVersion: "6.14.0",
      }
    );
    const transient = makeThunk(1, connErr);
    const result = await withInfraRetry(transient.run, { options, sleep: noSleep });
    expect(result).toBe("ok");
    expect(transient.calls()).toBe(2);
  });

  it("clamps a swapped min/max backoff", async () => {
    const t = makeThunk(1);
    const delays: number[] = [];
    await withInfraRetry(t.run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 300, backoffMaxMs: 100 },
      isRetryable: retryable,
      sleep: noSleep,
      random: () => 0.9,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });
    // min > max collapses to [100, 100], so the delay is 100 regardless of random
    expect(delays).toEqual([100]);
  });

  it("computes a jittered delay within bounds and reports it", async () => {
    const t = makeThunk(1);
    const delays: number[] = [];
    await withInfraRetry(t.run, {
      options: { enabled: true, maxAttempts: 3, backoffMinMs: 100, backoffMaxMs: 300 },
      isRetryable: retryable,
      sleep: noSleep,
      random: () => 0.5,
      onRetry: ({ delayMs }) => delays.push(delayMs),
    });
    expect(delays[0]).toBe(200);
  });

  it("keeps the delay finite and in range for bad backoff bounds and out-of-range random", async () => {
    // NaN backoff bound must not produce a NaN delay.
    const t1 = makeThunk(1);
    const nanDelays: number[] = [];
    await withInfraRetry(t1.run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 0, backoffMaxMs: NaN },
      isRetryable: retryable,
      sleep: noSleep,
      onRetry: ({ delayMs }) => nanDelays.push(delayMs),
    });
    expect(nanDelays[0]).toBe(0);

    // random() above 1 clamps to the high bound.
    const t2 = makeThunk(1);
    const highDelays: number[] = [];
    await withInfraRetry(t2.run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 100, backoffMaxMs: 300 },
      isRetryable: retryable,
      sleep: noSleep,
      random: () => 2,
      onRetry: ({ delayMs }) => highDelays.push(delayMs),
    });
    expect(highDelays[0]).toBe(300);

    // random() below 0 clamps to the low bound.
    const t3 = makeThunk(1);
    const lowDelays: number[] = [];
    await withInfraRetry(t3.run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 100, backoffMaxMs: 300 },
      isRetryable: retryable,
      sleep: noSleep,
      random: () => -1,
      onRetry: ({ delayMs }) => lowDelays.push(delayMs),
    });
    expect(lowDelays[0]).toBe(100);

    // random() returning NaN normalizes to the low bound, not a NaN delay.
    const t4 = makeThunk(1);
    const nanRandomDelays: number[] = [];
    await withInfraRetry(t4.run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 100, backoffMaxMs: 300 },
      isRetryable: retryable,
      sleep: noSleep,
      random: () => NaN,
      onRetry: ({ delayMs }) => nanRandomDelays.push(delayMs),
    });
    expect(nanRandomDelays[0]).toBe(100);
  });
});
