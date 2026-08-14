import { describe, expect, it, vi } from "vitest";
import {
  $transaction,
  isTransactionAcquisitionError,
  TokenBucketRetryBudget,
  UNLIMITED_RETRY_BUDGET,
  withTransactionStartRetry,
  type TransactionStartRetryConfig,
} from "./transaction";

function acquisitionError() {
  return { code: "P2028", message: "Unable to start a transaction in the given time." };
}

function poolTimeoutError() {
  return {
    code: "P2024",
    message: "Timed out fetching a new connection from the connection pool.",
  };
}

function inTxP2028() {
  return { code: "P2028", message: "Transaction API error: Transaction already closed." };
}

const noSleep = (_ms: number) => Promise.resolve();

function config(
  overrides?: Partial<TransactionStartRetryConfig["options"]>
): TransactionStartRetryConfig {
  return {
    options: {
      enabled: true,
      maxAttempts: 2,
      backoffMinMs: 50,
      backoffMaxMs: 250,
      ...overrides,
    },
    sleep: noSleep,
    random: () => 0,
  };
}

describe("isTransactionAcquisitionError", () => {
  it("is true only for P2028 raised at acquisition", () => {
    expect(isTransactionAcquisitionError(acquisitionError())).toBe(true);
  });

  it("is false for P2024 (pool exhaustion — retrying makes it worse)", () => {
    expect(isTransactionAcquisitionError(poolTimeoutError())).toBe(false);
  });

  it("is false for a P2028 raised inside a running transaction", () => {
    expect(isTransactionAcquisitionError(inTxP2028())).toBe(false);
  });

  it("is false for non-Prisma errors", () => {
    expect(isTransactionAcquisitionError(new Error("boom"))).toBe(false);
    expect(isTransactionAcquisitionError(undefined)).toBe(false);
  });
});

describe("withTransactionStartRetry", () => {
  it("runs once on success", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    await expect(withTransactionStartRetry(run, config())).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries an acquisition failure then succeeds", async () => {
    const run = vi.fn().mockRejectedValueOnce(acquisitionError()).mockResolvedValueOnce("ok");
    await expect(withTransactionStartRetry(run, config())).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry P2024", async () => {
    const err = poolTimeoutError();
    const run = vi.fn().mockRejectedValue(err);
    await expect(withTransactionStartRetry(run, config())).rejects.toBe(err);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops after maxAttempts total attempts", async () => {
    const run = vi.fn().mockRejectedValue(acquisitionError());
    await expect(withTransactionStartRetry(run, config({ maxAttempts: 3 }))).rejects.toMatchObject({
      code: "P2028",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("runs once when disabled", async () => {
    const run = vi.fn().mockRejectedValue(acquisitionError());
    await expect(withTransactionStartRetry(run, config({ enabled: false }))).rejects.toMatchObject({
      code: "P2028",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the budget is exhausted", async () => {
    const run = vi.fn().mockRejectedValue(acquisitionError());
    const budget = { tryConsume: vi.fn().mockReturnValue(false) };
    await expect(
      withTransactionStartRetry(run, { ...config({ maxAttempts: 5 }), budget })
    ).rejects.toMatchObject({ code: "P2028" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(budget.tryConsume).toHaveBeenCalledTimes(1);
  });

  it("sleeps a jittered delay within [min, max]", async () => {
    const delays: number[] = [];
    const run = vi.fn().mockRejectedValueOnce(acquisitionError()).mockResolvedValueOnce("ok");
    await withTransactionStartRetry(run, {
      options: { enabled: true, maxAttempts: 2, backoffMinMs: 50, backoffMaxMs: 250 },
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    });
    expect(delays).toEqual([150]);
  });
});

describe("TokenBucketRetryBudget", () => {
  it("allows up to burst then denies", () => {
    const budget = new TokenBucketRetryBudget({ ratePerSec: 0, burst: 2, now: () => 1000 });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
  });

  it("refills over time", () => {
    let now = 1000;
    const budget = new TokenBucketRetryBudget({ ratePerSec: 10, burst: 1, now: () => now });
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    now += 100;
    expect(budget.tryConsume()).toBe(true);
  });
});

describe("$transaction startRetry wiring", () => {
  it("retries a transaction start that fails with an acquisition error", async () => {
    let calls = 0;
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        if (calls === 1) return Promise.reject(acquisitionError());
        return fn({});
      }),
    } as any;

    const result = await $transaction(
      prisma,
      async () => "done",
      () => {},
      { startRetry: config() }
    );

    expect(result).toBe("done");
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry without a startRetry config", async () => {
    const err = acquisitionError();
    const prisma = { $transaction: vi.fn().mockRejectedValue(err) } as any;
    const onError = vi.fn();
    await expect($transaction(prisma, async () => "x", onError, {})).rejects.toBe(err);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it("passes maxWait through to prisma.$transaction options", async () => {
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    } as any;
    await $transaction(
      prisma,
      async () => "x",
      () => {},
      { maxWait: 10000 }
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10000 });
  });

  it("UNLIMITED_RETRY_BUDGET always consumes", () => {
    expect(UNLIMITED_RETRY_BUDGET.tryConsume()).toBe(true);
  });

  it("does not let maxRetries retry an acquisition error beyond the startRetry budget", async () => {
    const prisma = { $transaction: vi.fn().mockRejectedValue(acquisitionError()) } as any;
    await expect(
      $transaction(
        prisma,
        async () => "x",
        () => {},
        { startRetry: config({ maxAttempts: 2 }), maxRetries: 3 }
      )
    ).rejects.toMatchObject({ code: "P2028" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("still lets maxRetries retry a serialization error (P2034)", async () => {
    const serializationError = { code: "P2034", message: "write conflict / deadlock" };
    const prisma = { $transaction: vi.fn().mockRejectedValue(serializationError) } as any;
    await expect(
      $transaction(
        prisma,
        async () => "x",
        () => {},
        { maxRetries: 2 }
      )
    ).rejects.toMatchObject({ code: "P2034" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});
