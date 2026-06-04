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
};

const DEFAULT_REFRESH_INTERVAL_MS = 1000;

export class BackpressureMonitor {
  private verdict: BackpressureVerdict | null = null;
  private timer?: ReturnType<typeof setInterval>;

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

  /** Hot-path read: synchronous, never performs I/O. */
  shouldSkipDequeue(): boolean {
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

  private async refresh(): Promise<void> {
    try {
      this.verdict = await this.opts.source.read();
    } catch {
      // Fail-open: a dead/unreachable source must never pin the brake. Treat as
      // unknown (no verdict) so dequeue resumes as if backpressure were off.
      this.verdict = null;
    }
  }
}
