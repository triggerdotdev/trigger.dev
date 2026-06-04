export type BackpressureVerdict = {
  engaged: boolean;
  /** Epoch ms the verdict was produced. Used for consumer-side staleness fail-open. */
  ts?: number;
};

/**
 * Source of the current backpressure verdict. `read()` returns `null` when the
 * verdict is unknown (missing/unreadable) - the monitor treats unknown as
 * "not engaged" (fail-open).
 */
export interface BackpressureSignalSource {
  read(): Promise<BackpressureVerdict | null>;
}

export type BackpressureMonitorOptions = {
  enabled: boolean;
  source: BackpressureSignalSource;
  refreshIntervalMs?: number;
  /**
   * If set, a cached verdict older than this is treated as unknown (fail-open).
   * Guards against the source silently going stale (e.g. hanging reads).
   */
  maxVerdictAgeMs?: number;
  /**
   * If set, after backpressure releases the dequeue gate stays partially engaged
   * for this long, skipping a linearly-decaying fraction of attempts so the
   * aggregate dequeue rate ramps from ~0 to full instead of snapping to full and
   * re-flooding a freshly-recovered cluster. 0/unset = instant resume.
   */
  rampMs?: number;
  /** Injectable RNG for the resume ramp; defaults to Math.random. */
  random?: () => number;
};

const DEFAULT_REFRESH_INTERVAL_MS = 1000;

export class BackpressureMonitor {
  private verdict: BackpressureVerdict | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private wasEngaged = false;
  private releasedAt?: number;

  constructor(private readonly opts: BackpressureMonitorOptions) {}

  start(): void {
    if (!this.opts.enabled) {
      return;
    }

    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      this.opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Hard backpressure state: true while the (fresh) verdict says engaged. This is
   * the signal for freezing consumer-pool scale-up - distinct from the dequeue
   * gate, which additionally ramps after release. Hot-path read, no I/O.
   */
  isEngaged(): boolean {
    const verdict = this.verdict;
    if (verdict?.engaged !== true) {
      return false;
    }

    const maxAge = this.opts.maxVerdictAgeMs;
    if (maxAge !== undefined && verdict.ts !== undefined && Date.now() - verdict.ts > maxAge) {
      return false;
    }

    return true;
  }

  /** Hot-path read: synchronous, never performs I/O. */
  shouldSkipDequeue(): boolean {
    if (this.isEngaged()) {
      return true;
    }

    // Post-release ramp: skip a linearly-decaying fraction of attempts so the
    // aggregate dequeue rate climbs back to full over rampMs rather than snapping.
    const rampMs = this.opts.rampMs;
    if (rampMs && this.releasedAt !== undefined) {
      const elapsed = Date.now() - this.releasedAt;
      if (elapsed < rampMs) {
        const skipProbability = 1 - elapsed / rampMs;
        return (this.opts.random ?? Math.random)() < skipProbability;
      }
    }

    return false;
  }

  private async refresh(): Promise<void> {
    try {
      this.verdict = await this.opts.source.read();
    } catch {
      // Fail-open: a dead/unreachable source must never pin the brake. Treat as
      // unknown (no verdict) so dequeue resumes as if backpressure were off.
      this.verdict = null;
    }

    // Track the engaged→released transition to anchor the resume ramp. Based on
    // the raw refreshed verdict, not the staleness-adjusted read.
    const nowEngaged = this.verdict?.engaged === true;
    if (this.wasEngaged && !nowEngaged) {
      this.releasedAt = Date.now();
    }
    this.wasEngaged = nowEngaged;
  }
}
