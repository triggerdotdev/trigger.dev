// The engine's shutdown execution, factored out of RunEngine so the ordering, the attempt-everything
// guarantee and the strict/best-effort split are exercised directly rather than through a live engine.

/** One engine shutdown operation that rejected, with the name it is logged and reported under. */
export type RunEngineShutdownFailure = { operation: string; error: unknown };

export type ShutdownOperation = { operation: string; stop: () => Promise<unknown> };

/** `AggregateError` is ES2021 and this package compiles against the ES2020 libs, so type the global. */
export type ShutdownAggregateError = Error & { errors: unknown[] };
declare const AggregateError: new (errors: unknown[], message?: string) => ShutdownAggregateError;

/**
 * Runs the phases in order and every operation WITHIN a phase concurrently, attempting all of them
 * regardless of the others' outcomes. Returns the operations that rejected, in phase order.
 */
export async function executeShutdownPhases(
  phases: ShutdownOperation[][],
  onFailure: (failure: RunEngineShutdownFailure) => void
): Promise<RunEngineShutdownFailure[]> {
  const failures: RunEngineShutdownFailure[] = [];

  for (const phase of phases) {
    const results = await Promise.allSettled(phase.map((operation) => operation.stop()));

    results.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const failure = {
        operation: phase[index]?.operation ?? `operation[${index}]`,
        error: result.reason,
      };
      onFailure(failure);
      failures.push(failure);
    });
  }

  return failures;
}

/** Every stop the engine performs on shutdown, named as it is logged and reported. */
export type EngineShutdownStops = {
  runQueueQuit: () => Promise<unknown>;
  workerStop: () => Promise<unknown>;
  ttlWorkerStop: () => Promise<unknown>;
  batchQueueClose: () => Promise<unknown>;
  runLockQuit: () => Promise<unknown>;
  debounceSystemQuit: () => Promise<unknown>;
  runLockRedisDisconnect: () => Promise<unknown>;
};

/**
 * The engine's shutdown order: the resources that actively process work, then the support resources
 * they use, then the forced run-lock disconnect. The disconnect is a PHASE rather than a trailing
 * try/catch so a failure there is collected and reported like every other stop.
 */
export function engineShutdownPhases(stops: EngineShutdownStops): ShutdownOperation[][] {
  return [
    [
      { operation: "runQueue.quit", stop: stops.runQueueQuit },
      { operation: "worker.stop", stop: stops.workerStop },
      { operation: "ttlWorker.stop", stop: stops.ttlWorkerStop },
      { operation: "batchQueue.close", stop: stops.batchQueueClose },
    ],
    [
      { operation: "runLock.quit", stop: stops.runLockQuit },
      { operation: "debounceSystem.quit", stop: stops.debounceSystemQuit },
    ],
    [{ operation: "runLockRedis.disconnect", stop: stops.runLockRedisDisconnect }],
  ];
}

export function shutdownAggregateError(
  failures: RunEngineShutdownFailure[]
): ShutdownAggregateError | undefined {
  if (failures.length === 0) return undefined;

  return new AggregateError(
    failures.map((failure) => failure.error),
    `RunEngine shutdown: ${failures.length} operation(s) failed: ${failures
      .map((failure) => failure.operation)
      .join(", ")}`
  );
}

/**
 * Wraps ONE shutdown execution so default and strict callers share it. The execution resolves with
 * its failures instead of rejecting, so a strict caller still observes them when a default caller
 * started (and therefore owns) the shutdown.
 */
export function createShutdownGate(
  execute: () => Promise<RunEngineShutdownFailure[]>
): (options?: { rejectOnFailure?: boolean }) => Promise<void> {
  let started: Promise<RunEngineShutdownFailure[]> | undefined;
  // Each variant's derived promise is memoized too, so repeat callers get the IDENTICAL promise that
  // the pre-strict `quit()` returned. Built on demand: an unobserved strict promise would be an
  // unhandled rejection.
  let bestEffort: Promise<void> | undefined;
  let strict: Promise<void> | undefined;

  return (options) => {
    started ??= execute();
    const settled = started;

    if (!options?.rejectOnFailure) {
      bestEffort ??= settled.then(() => undefined);
      return bestEffort;
    }

    strict ??= settled.then((failures) => {
      const error = shutdownAggregateError(failures);
      if (error) throw error;
    });
    return strict;
  };
}
