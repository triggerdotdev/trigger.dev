import type { BackpressureMetrics } from "./backpressureMetrics.js";

interface BackpressureLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type BackpressureVerdict = {
  engaged: boolean;
  /** Epoch ms the verdict was produced. Used for consumer-side staleness fail-open. */
  ts?: number;
};

/**
 * Source of the current backpressure verdict. `read()` returns `null` when the source
 * answered but there is no verdict - the monitor treats that as "not engaged"
 * (fail-open). A thrown error is different: the read itself failed, so the monitor
 * keeps the previous verdict until it ages past `maxVerdictAgeMs`.
 */
export interface BackpressureSignalSource {
  read(): Promise<BackpressureVerdict | null>;
}

export type BackpressureMonitorOptions = {
  enabled: boolean;
  source: BackpressureSignalSource;
  refreshIntervalMs?: number;
  /**
   * If set, an engaged verdict older than this is released (fail-open), bounding how
   * long a dead source can hold the brake. Reads that fail keep the last verdict, so
   * this doubles as the grace window for riding out a transient source outage.
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
  /**
   * When true, the gates are inert (never skip dequeues, never freeze scale-up).
   * computeEngaged() still reflects the real signal so it can be observed.
   */
  dryRun?: boolean;
  logger?: BackpressureLogger;
  metrics?: BackpressureMetrics;
};

const DEFAULT_REFRESH_INTERVAL_MS = 1000;

export class BackpressureMonitor {
  private verdict: BackpressureVerdict | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private refreshInFlight = false;
  private wasEngaged = false;
  private releasedAt?: number;
  private readFailing = false;

  constructor(private readonly opts: BackpressureMonitorOptions) {
    this.opts.metrics?.dryRun.set(this.opts.dryRun ? 1 : 0);
  }

  start(): void {
    if (!this.opts.enabled) {
      return;
    }

    void this.refreshTick();
    this.timer = setInterval(
      () => void this.refreshTick(),
      this.opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    );
  }

  /** Skip a tick if the previous refresh is still in flight, so slow/hung reads can't stack. */
  private async refreshTick(): Promise<void> {
    if (this.refreshInFlight) {
      return;
    }
    this.refreshInFlight = true;
    try {
      await this.refresh();
    } finally {
      this.refreshInFlight = false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Raw hard backpressure state: true while the (fresh) verdict says engaged,
   * ignoring dry-run. Used for observability/metrics so the real signal is
   * visible even when the gates are inert.
   */
  computeEngaged(): boolean {
    const verdict = this.verdict;
    if (verdict?.engaged !== true) {
      return false;
    }

    // When staleness enforcement is on, an engaged verdict must carry a fresh
    // timestamp. A missing or stale ts can't be trusted (a dead producer could
    // otherwise pin the brake forever), so fail open.
    const maxAge = this.opts.maxVerdictAgeMs;
    if (maxAge !== undefined) {
      if (verdict.ts === undefined || Date.now() - verdict.ts > maxAge) {
        return false;
      }
    }

    return true;
  }

  /**
   * Effective hard state: the signal for freezing consumer-pool scale-up. Inert
   * (false) in dry-run. Hot-path read, no I/O.
   */
  isEngaged(): boolean {
    return this.opts.dryRun ? false : this.computeEngaged();
  }

  /** Hot-path read: synchronous, never performs I/O. Inert (false) in dry-run. */
  shouldSkipDequeue(): boolean {
    const wouldSkip = this.computeShouldSkip();
    if (wouldSkip) {
      this.opts.metrics?.skipsTotal.inc({ dry_run: this.opts.dryRun ? "true" : "false" });
    }
    return this.opts.dryRun ? false : wouldSkip;
  }

  private computeShouldSkip(): boolean {
    if (this.computeEngaged()) {
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
    let next: BackpressureVerdict | null = null;
    let readError: unknown;
    try {
      next = await this.opts.source.read();
    } catch (error) {
      readError = error;
    }

    if (readError === undefined) {
      this.verdict = next; // an explicit null means "no pressure", so honour it
      this.readFailing = false;
    } else {
      const held = this.opts.maxVerdictAgeMs !== undefined;
      if (!held) {
        this.verdict = null; // unbounded hold could pin the brake forever
      }
      this.opts.metrics?.readFailuresTotal.inc();
      if (!this.readFailing) {
        this.readFailing = true; // log once per outage, not once per tick
        this.opts.logger?.error("backpressure read failed", {
          reason: String(readError),
          heldPreviousVerdict: held,
          engaged: this.computeEngaged(),
        });
      }
    }

    // Track the engaged→released transition to anchor the resume ramp. Use the
    // staleness-aware state so a stale verdict doesn't pin wasEngaged / the gauge.
    const nowEngaged = this.computeEngaged();
    this.opts.metrics?.engaged.set(nowEngaged ? 1 : 0);

    if (nowEngaged !== this.wasEngaged) {
      this.opts.logger?.info("backpressure verdict changed", {
        engaged: nowEngaged,
        dryRun: !!this.opts.dryRun,
      });
    }
    if (this.wasEngaged && !nowEngaged) {
      this.releasedAt = Date.now();
    }
    this.wasEngaged = nowEngaged;
  }
}
