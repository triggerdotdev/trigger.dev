import { describe, expect, it } from "vitest";
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

function counter() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    tick() {
      calls += 1;
    },
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
    const c = counter();
    const run = async () => {
      c.tick();
      return "ok";
    };
    await expect(withTransactionStartRetry(run, config())).resolves.toBe("ok");
    expect(c.calls).toBe(1);
  });

  it("retries an acquisition failure then succeeds", async () => {
    const c = counter();
    const run = async () => {
      c.tick();
      if (c.calls === 1) throw acquisitionError();
      return "ok";
    };
    await expect(withTransactionStartRetry(run, config())).resolves.toBe("ok");
    expect(c.calls).toBe(2);
  });

  it("does NOT retry P2024", async () => {
    const c = counter();
    const err = poolTimeoutError();
    const run = async () => {
      c.tick();
      throw err;
    };
    await expect(withTransactionStartRetry(run, config())).rejects.toBe(err);
    expect(c.calls).toBe(1);
  });

  it("stops after maxAttempts total attempts", async () => {
    const c = counter();
    const run = async () => {
      c.tick();
      throw acquisitionError();
    };
    await expect(withTransactionStartRetry(run, config({ maxAttempts: 3 }))).rejects.toMatchObject({
      code: "P2028",
    });
    expect(c.calls).toBe(3);
  });

  it("runs once when disabled", async () => {
    const c = counter();
    const run = async () => {
      c.tick();
      throw acquisitionError();
    };
    await expect(withTransactionStartRetry(run, config({ enabled: false }))).rejects.toMatchObject({
      code: "P2028",
    });
    expect(c.calls).toBe(1);
  });

  it("does not retry when the budget is exhausted", async () => {
    const c = counter();
    const budgetChecks = counter();
    const run = async () => {
      c.tick();
      throw acquisitionError();
    };
    const budget = {
      tryConsume() {
        budgetChecks.tick();
        return false;
      },
    };
    await expect(
      withTransactionStartRetry(run, { ...config({ maxAttempts: 5 }), budget })
    ).rejects.toMatchObject({ code: "P2028" });
    expect(c.calls).toBe(1);
    expect(budgetChecks.calls).toBe(1);
  });

  it("sleeps a jittered delay within [min, max]", async () => {
    const c = counter();
    const delays: number[] = [];
    const run = async () => {
      c.tick();
      if (c.calls === 1) throw acquisitionError();
      return "ok";
    };
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
  function fakeClient(behavior: (call: number) => Promise<unknown>) {
    const c = counter();
    return {
      client: {
        $transaction: (fn: (tx: unknown) => Promise<unknown>, _options?: unknown) => {
          c.tick();
          return behavior(c.calls).then(() => fn({}));
        },
      } as any,
      get calls() {
        return c.calls;
      },
    };
  }

  it("retries a transaction start that fails with an acquisition error", async () => {
    const fake = fakeClient((call) =>
      call === 1 ? Promise.reject(acquisitionError()) : Promise.resolve()
    );
    const result = await $transaction(
      fake.client,
      async () => "done",
      () => {},
      { startRetry: config() }
    );
    expect(result).toBe("done");
    expect(fake.calls).toBe(2);
  });

  it("does not retry without a startRetry config", async () => {
    const err = acquisitionError();
    const fake = fakeClient(() => Promise.reject(err));
    let captured: unknown;
    await expect(
      $transaction(
        fake.client,
        async () => "x",
        (e) => {
          captured = e;
        },
        {}
      )
    ).rejects.toBe(err);
    expect(fake.calls).toBe(1);
    expect(captured).toBe(err);
  });

  it("passes maxWait through to prisma.$transaction options", async () => {
    let seenOptions: unknown;
    const client = {
      $transaction: (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        seenOptions = options;
        return fn({});
      },
    } as any;
    await $transaction(
      client,
      async () => "x",
      () => {},
      { maxWait: 10000 }
    );
    expect(seenOptions).toEqual({ maxWait: 10000 });
  });

  it("does not let maxRetries retry an acquisition error while startRetry is active", async () => {
    const fake = fakeClient(() => Promise.reject(acquisitionError()));
    await expect(
      $transaction(
        fake.client,
        async () => "x",
        () => {},
        { startRetry: config({ maxAttempts: 2 }), maxRetries: 3 }
      )
    ).rejects.toMatchObject({ code: "P2028" });
    expect(fake.calls).toBe(2);
  });

  it("falls back to maxRetries for acquisition errors when startRetry is disabled", async () => {
    const fake = fakeClient(() => Promise.reject(acquisitionError()));
    await expect(
      $transaction(
        fake.client,
        async () => "x",
        () => {},
        { startRetry: config({ enabled: false }), maxRetries: 3 }
      )
    ).rejects.toMatchObject({ code: "P2028" });
    expect(fake.calls).toBe(4);
  });

  it("still lets maxRetries retry a serialization error (P2034)", async () => {
    const serializationError = { code: "P2034", message: "write conflict / deadlock" };
    const fake = fakeClient(() => Promise.reject(serializationError));
    await expect(
      $transaction(
        fake.client,
        async () => "x",
        () => {},
        { maxRetries: 2 }
      )
    ).rejects.toMatchObject({ code: "P2034" });
    expect(fake.calls).toBe(3);
  });

  it("UNLIMITED_RETRY_BUDGET always consumes", () => {
    expect(UNLIMITED_RETRY_BUDGET.tryConsume()).toBe(true);
  });
});
