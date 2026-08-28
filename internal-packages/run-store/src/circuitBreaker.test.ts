// The residency cache removes the steady-state round trip, but a process that has not yet seen a run
// still probes once, and under a brownout that one probe costs the full retry budget (measured: about
// 2.07s, from 4 attempts at a 500ms command timeout plus backoff). The breaker bounds that: after a
// few connectivity failures the store stops trying at all, so a sick Redis takes itself off the run
// path without an operator.
import { describe, expect, it } from "vitest";
import { CircuitBreaker, SnapshotStoreUnavailableError } from "./circuitBreaker.js";

const OPTS = { failureThreshold: 3, openDurationMs: 1_000 };

function connectivityError(message = "Command timed out"): Error {
  return new Error(message);
}

describe("CircuitBreaker", () => {
  it("passes calls through while closed", async () => {
    const breaker = new CircuitBreaker(OPTS);
    expect(await breaker.run(async () => "ok")).toBe("ok");
  });

  it("stays closed while failures are below the threshold", async () => {
    const breaker = new CircuitBreaker(OPTS);
    for (let i = 0; i < 2; i++) {
      await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
    }
    expect(breaker.state).toBe("closed");
  });

  it("opens on the threshold and then refuses without calling through", async () => {
    const breaker = new CircuitBreaker(OPTS);
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
    }
    expect(breaker.state).toBe("open");

    let called = false;
    await expect(
      breaker.run(async () => {
        called = true;
        return "ok";
      })
    ).rejects.toBeInstanceOf(SnapshotStoreUnavailableError);
    // The point of the breaker: the doomed call is not made, so it costs nothing rather than a
    // timeout.
    expect(called).toBe(false);
  });

  it("a success resets the count, so intermittent failures never accumulate to an open", async () => {
    const breaker = new CircuitBreaker(OPTS);
    for (let i = 0; i < 5; i++) {
      await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
      await breaker.run(async () => "ok");
    }
    expect(breaker.state).toBe("closed");
  });

  it("half-opens after the open window and closes on a successful trial", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 20 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
    }
    expect(breaker.state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await breaker.run(async () => "recovered")).toBe("recovered");
    expect(breaker.state).toBe("closed");
  });

  it("re-opens when the trial call fails again", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 20 });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(breaker.run(async () => Promise.reject(connectivityError()))).rejects.toThrow();
    expect(breaker.state).toBe("open");
  });

  it("ignores a script error, because a bug is not an outage", async () => {
    // WRONGTYPE and other Lua errors mean the data or the script is wrong, and every retry against
    // every node will fail the same way. Counting them would open the breaker on a defect and take
    // the mirror down for runs that are perfectly healthy.
    const breaker = new CircuitBreaker(OPTS);
    for (let i = 0; i < 10; i++) {
      await expect(
        breaker.run(async () =>
          Promise.reject(
            new Error("WRONGTYPE Operation against a key holding the wrong kind of value")
          )
        )
      ).rejects.toThrow();
    }
    expect(breaker.state).toBe("closed");
  });
});
