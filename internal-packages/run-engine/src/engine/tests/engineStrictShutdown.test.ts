// PR #83: RunEngine's shutdown is best-effort. Every stop is attempted with `Promise.allSettled` and
// failures are only logged, so `quit()` resolves even when the worker, TTL worker, run queue, batch
// queue, run lock or debounce system failed to stop. A caller that OWNS a resource the engine writes
// to (the snapshot store's MemoryDB client) therefore cannot tell that a component may still be live,
// and tears that resource down underneath it.
//
// The strict variant reports the aggregate failures to the caller over the SAME single shutdown
// execution. RED before the fix: `quit()` had no options and always resolved, so the strict
// assertions below fail.
//
// The per-operation cases drive the real shutdown executor with pure promise builders (no mocks — the
// engine's own components cannot be made to fail on demand with real infrastructure). The final case
// drives a real engine against real Postgres and real Redis.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, it } from "vitest";
import { RunEngine } from "../index.js";
import {
  createShutdownGate,
  engineShutdownPhases,
  executeShutdownPhases,
  shutdownAggregateError,
  type RunEngineShutdownFailure,
  type ShutdownAggregateError,
} from "../shutdown.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The engine's real shape: the four processing stops, then the two support stops.
function phasesWithFailures(attempted: string[], failing: string[]) {
  const op = (operation: string) => ({
    operation,
    stop: async () => {
      attempted.push(operation);
      if (failing.includes(operation)) {
        throw new Error(`__${operation}_failed__`);
      }
    },
  });

  return [
    [op("runQueue.quit"), op("worker.stop"), op("ttlWorker.stop"), op("batchQueue.close")],
    [op("runLock.quit"), op("debounceSystem.quit")],
  ];
}

const ALL_OPERATIONS = [
  "runQueue.quit",
  "worker.stop",
  "ttlWorker.stop",
  "batchQueue.close",
  "runLock.quit",
  "debounceSystem.quit",
];

// The PRODUCTION phase list, with only the forced run-lock disconnect failing. The disconnect used
// to be a trailing try/catch that merely logged, so a strict caller released shared resources while
// that connection was still live. Driving engineShutdownPhases means dropping the disconnect from
// the production list turns these assertions red.
function productionPhasesWithFailingDisconnect(attempted: string[]) {
  const ok = (operation: string) => async () => {
    attempted.push(operation);
  };

  return engineShutdownPhases({
    runQueueQuit: ok("runQueue.quit"),
    workerStop: ok("worker.stop"),
    ttlWorkerStop: ok("ttlWorker.stop"),
    batchQueueClose: ok("batchQueue.close"),
    runLockQuit: ok("runLock.quit"),
    debounceSystemQuit: ok("debounceSystem.quit"),
    runLockRedisDisconnect: async () => {
      attempted.push("runLockRedis.disconnect");
      throw new Error("__runLockRedis.disconnect_failed__");
    },
  });
}

describe("RunEngine strict shutdown drain (PR #83)", () => {
  it("attempts every shutdown operation even when earlier ones fail", async () => {
    const attempted: string[] = [];
    const logged: RunEngineShutdownFailure[] = [];

    const failures = await executeShutdownPhases(
      phasesWithFailures(attempted, ["runQueue.quit", "runLock.quit"]),
      (failure) => logged.push(failure)
    );

    expect(attempted.sort(), "every operation is attempted").toEqual([...ALL_OPERATIONS].sort());
    expect(failures.map((f) => f.operation)).toEqual(["runQueue.quit", "runLock.quit"]);
    expect(
      logged.map((f) => f.operation),
      "every failure is still logged"
    ).toEqual(["runQueue.quit", "runLock.quit"]);
  });

  it("keeps the phase order: support resources stop only after the processing resources", async () => {
    const attempted: string[] = [];

    await executeShutdownPhases(phasesWithFailures(attempted, ["worker.stop"]), () => {});

    expect(attempted.slice(0, 4).sort()).toEqual(
      ["runQueue.quit", "worker.stop", "ttlWorker.stop", "batchQueue.close"].sort()
    );
    expect(attempted.slice(4).sort()).toEqual(["runLock.quit", "debounceSystem.quit"].sort());
  });

  it("default quit() stays best-effort and strict quit() rejects with every named failure", async () => {
    const attempted: string[] = [];
    let executions = 0;
    const quit = createShutdownGate(async () => {
      executions++;
      return executeShutdownPhases(
        phasesWithFailures(attempted, ["worker.stop", "debounceSystem.quit"]),
        () => {}
      );
    });

    await expect(
      quit(),
      "the default contract resolves after all attempts"
    ).resolves.toBeUndefined();

    const strictError = await quit({ rejectOnFailure: true }).then(
      () => undefined,
      (error: unknown) => error
    );

    const aggregate = strictError as ShutdownAggregateError;
    expect(aggregate?.constructor?.name, "the strict variant rejects with an AggregateError").toBe(
      "AggregateError"
    );
    expect(aggregate.message).toContain("worker.stop");
    expect(aggregate.message).toContain("debounceSystem.quit");
    expect(aggregate.errors.map((e) => (e as Error).message)).toEqual([
      "__worker.stop_failed__",
      "__debounceSystem.quit_failed__",
    ]);

    expect(executions, "the shutdown executes exactly once").toBe(1);
    expect(attempted.sort(), "operations are attempted once, not per caller").toEqual(
      [...ALL_OPERATIONS].sort()
    );
  });

  it("a failed run-lock disconnect reaches the strict caller but not the default one", async () => {
    const attempted: string[] = [];
    const logged: RunEngineShutdownFailure[] = [];
    let executions = 0;
    const quit = createShutdownGate(async () => {
      executions++;
      return executeShutdownPhases(productionPhasesWithFailingDisconnect(attempted), (failure) =>
        logged.push(failure)
      );
    });

    await expect(quit(), "default quit stays best-effort").resolves.toBeUndefined();

    const error = await quit({ rejectOnFailure: true }).then(
      () => undefined,
      (reason: unknown) => reason as ShutdownAggregateError
    );

    expect(
      error,
      "strict quit must reject when the forced run-lock disconnect fails"
    ).toBeDefined();
    expect(error?.message).toContain("runLockRedis.disconnect");
    expect((error?.errors[0] as Error | undefined)?.message).toBe(
      "__runLockRedis.disconnect_failed__"
    );
    expect(
      logged.map((f) => f.operation),
      "still logged"
    ).toEqual(["runLockRedis.disconnect"]);
    expect(attempted.at(-1), "the disconnect runs last, after every other stop").toBe(
      "runLockRedis.disconnect"
    );
    expect(attempted).toHaveLength(ALL_OPERATIONS.length + 1);
    expect(executions, "one execution shared by both callers").toBe(1);
  });

  it("a strict call still rejects for a shutdown a default call already started", async () => {
    const release = deferred();
    let executions = 0;
    const quit = createShutdownGate(async () => {
      executions++;
      await release.promise;
      return executeShutdownPhases(phasesWithFailures([], ["ttlWorker.stop"]), () => {});
    });

    // The default caller owns the in-flight execution; the strict caller joins it mid-flight.
    const best = quit();
    const strict = quit({ rejectOnFailure: true });
    release.resolve();

    await expect(best).resolves.toBeUndefined();
    await expect(strict).rejects.toThrow(/ttlWorker\.stop/);
    expect(executions).toBe(1);
  });

  it("resolves both variants and stays idempotent when nothing fails", async () => {
    const attempted: string[] = [];
    let executions = 0;
    const quit = createShutdownGate(async () => {
      executions++;
      return executeShutdownPhases(phasesWithFailures(attempted, []), () => {});
    });

    // Promise identity per variant, which shutdown.test.ts relies on to prove one execution.
    const first = quit();
    expect(quit(), "repeat default calls share one promise").toBe(first);
    const firstStrict = quit({ rejectOnFailure: true });
    expect(quit({ rejectOnFailure: true }), "repeat strict calls share one promise").toBe(
      firstStrict
    );

    await expect(first).resolves.toBeUndefined();
    await expect(firstStrict).resolves.toBeUndefined();
    expect(quit(), "identity survives completion").toBe(first);

    expect(executions).toBe(1);
    expect(attempted).toHaveLength(ALL_OPERATIONS.length);
    expect(shutdownAggregateError([])).toBeUndefined();
  });

  // Real engine, real Postgres, real Redis: the strict option reaches the engine's own shutdown and a
  // clean drain resolves through it, exactly once, however many times it is called.
  containerTest(
    "a real engine's strict quit() resolves on a clean drain and executes once",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      await expect(engine.quit({ rejectOnFailure: true })).resolves.toBeUndefined();
      // Repeated calls, in either variant, join the completed execution instead of re-running it.
      await expect(engine.quit({ rejectOnFailure: true })).resolves.toBeUndefined();
      await expect(engine.quit()).resolves.toBeUndefined();
    }
  );
});
