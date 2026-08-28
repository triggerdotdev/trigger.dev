/**
 * Thrown instead of attempting a call the breaker has decided will fail. Named so callers can tell
 * "Redis is not answering" apart from "Redis answered and said no", which need different handling:
 * the first falls back, the second is a real result.
 */
export class SnapshotStoreUnavailableError extends Error {
  constructor(message = "snapshot store is unavailable (circuit open)") {
    super(message);
    this.name = "SnapshotStoreUnavailableError";
  }
}

export type CircuitBreakerOptions = {
  /** Consecutive connectivity failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is allowed through. */
  openDurationMs?: number;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
};

export type CircuitState = "closed" | "open" | "half-open";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_DURATION_MS = 10_000;

/**
 * Connectivity, not correctness.
 *
 * A Lua error means the script or the data is wrong: every retry, against every node, fails the same
 * way, and no amount of waiting helps. Counting those would open the circuit on a defect and stop
 * mirroring runs that are perfectly healthy. A timeout, a closed connection or a down cluster is the
 * opposite: nothing about the request is wrong, the server is simply not answering.
 */
function isConnectivityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/WRONGTYPE|NOSCRIPT|ERR |Lua |user_script/i.test(message)) {
    return false;
  }
  return /timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|Connection is closed|Stream isn't writeable|CLUSTERDOWN|max retries|Failed to refresh slots/i.test(
    message
  );
}

/**
 * Stops a process paying the retry budget over and over for a Redis that is not answering.
 *
 * The residency cache already removes the steady-state round trip; this bounds what is left. One
 * transition's worth of failed attempts opens the circuit, and every later call returns immediately
 * instead of waiting out another timeout. A sick Redis therefore takes ITSELF off the run path,
 * which is the property that makes the low dial positions inert under fault without an operator
 * setting a second control.
 *
 * Per process and per client. The sweep holds its own connection and must not trip this one: a long
 * scan failing is not evidence that the hot path cannot write.
 */
export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #openDurationMs: number;
  readonly #now: () => number;
  #consecutiveFailures = 0;
  #openedAt?: number;
  /**
   * Whether a half-open trial is already out. Without it every concurrent caller reads `half-open`
   * and enters the call, so during an outage each one pays the full retry timeout, which is the cost
   * the breaker exists to avoid. One caller probes recovery; the rest are refused until it settles.
   */
  #trialInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.#openDurationMs = options.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.#now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.#openedAt === undefined) {
      return "closed";
    }
    return this.#now() - this.#openedAt >= this.#openDurationMs ? "half-open" : "open";
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;

    if (state === "open") {
      throw new SnapshotStoreUnavailableError();
    }

    // Reserved BEFORE the call, not after: the reservation is the whole point, and checking it
    // afterwards would let every arriving caller through first.
    if (state === "half-open") {
      if (this.#trialInFlight) {
        throw new SnapshotStoreUnavailableError();
      }
      this.#trialInFlight = true;
    }

    try {
      const result = await fn();
      this.#consecutiveFailures = 0;
      this.#openedAt = undefined;
      return result;
    } catch (error) {
      if (!isConnectivityFailure(error)) {
        // A success resets the counter and so does an unrelated error: only an unbroken run of
        // connectivity failures is evidence the endpoint is gone.
        this.#consecutiveFailures = 0;
        throw error;
      }

      this.#consecutiveFailures += 1;
      // `state` is captured above: reading this.state here would see the value AFTER a re-open and
      // could not tell a failed trial from an ordinary failure.
      if (state === "half-open" || this.#consecutiveFailures >= this.#failureThreshold) {
        this.#openedAt = this.#now();
        this.#consecutiveFailures = 0;
      }
      throw error;
    } finally {
      // Always released, whatever the outcome. A trial that threw something unexpected must not
      // leave the breaker refusing every caller for the rest of the process's life.
      if (state === "half-open") {
        this.#trialInFlight = false;
      }
    }
  }
}
