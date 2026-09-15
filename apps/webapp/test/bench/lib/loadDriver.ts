/**
 * Closed-loop load driver.
 *
 * A fixed number of virtual workers each run an async task in a loop for the
 * duration of the run. Closed-loop, rather than a fixed arrival rate, is the
 * right model here because it is what the supervisor actually does: it holds a
 * bounded pool of consumers and each one issues its next request only after the
 * previous one returns. An open-loop generator would queue work the real caller
 * would never have sent, and the latency tail would then describe the
 * generator's own backlog instead of the server.
 */
export type OperationStats = {
  name: string;
  count: number;
  errors: number;
  throughputPerSecond: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};

export class LatencyRecorder {
  private byName = new Map<string, { durations: number[]; errors: number }>();
  private startedAt = 0;
  private endedAt = 0;

  begin(): void {
    this.startedAt = performance.now();
  }

  end(): void {
    this.endedAt = performance.now();
  }

  record(name: string, durationMs: number, ok: boolean): void {
    let entry = this.byName.get(name);
    if (!entry) {
      entry = { durations: [], errors: 0 };
      this.byName.set(name, entry);
    }
    entry.durations.push(durationMs);
    if (!ok) entry.errors += 1;
  }

  /** Times `fn` under `name`. A rejection is recorded as an error, never rethrown. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const start = performance.now();
    try {
      const result = await fn();
      this.record(name, performance.now() - start, true);
      return result;
    } catch {
      this.record(name, performance.now() - start, false);
      return undefined;
    }
  }

  private elapsedSeconds(): number {
    const end = this.endedAt || performance.now();
    return Math.max((end - this.startedAt) / 1000, 1e-9);
  }

  stats(): OperationStats[] {
    const seconds = this.elapsedSeconds();

    return [...this.byName.entries()]
      .map(([name, { durations, errors }]) => {
        const sorted = [...durations].sort((a, b) => a - b);
        const at = (q: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;

        return {
          name,
          count: sorted.length,
          errors,
          throughputPerSecond: sorted.length / seconds,
          meanMs: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
          p50Ms: at(0.5),
          p95Ms: at(0.95),
          p99Ms: at(0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  totals(): { count: number; errors: number; throughputPerSecond: number } {
    const all = this.stats();
    const count = all.reduce((sum, s) => sum + s.count, 0);
    const errors = all.reduce((sum, s) => sum + s.errors, 0);
    return { count, errors, throughputPerSecond: count / this.elapsedSeconds() };
  }
}

export type LoadRunOptions = {
  /** Number of concurrent virtual workers. */
  concurrency: number;
  /** How long to keep issuing work. */
  durationMs: number;
  /** One iteration of a single virtual worker. */
  iteration: (workerIndex: number, iterationIndex: number) => Promise<void>;
  /** Runs once per worker before the measured window. Not recorded. */
  warmup?: (workerIndex: number) => Promise<void>;
};

export async function runLoad(options: LoadRunOptions): Promise<void> {
  const { concurrency, durationMs, iteration, warmup } = options;

  if (warmup) {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => warmup(i)));
  }

  const deadline = Date.now() + durationMs;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, workerIndex) => {
      let iterationIndex = 0;
      while (Date.now() < deadline) {
        await iteration(workerIndex, iterationIndex++);
      }
    })
  );
}

export function formatStatsTable(stats: OperationStats[]): string {
  const header = ["operation", "count", "err", "req/s", "mean", "p50", "p95", "p99", "max"];
  const rows = stats.map((s) => [
    s.name,
    String(s.count),
    String(s.errors),
    s.throughputPerSecond.toFixed(1),
    `${s.meanMs.toFixed(2)}ms`,
    `${s.p50Ms.toFixed(2)}ms`,
    `${s.p95Ms.toFixed(2)}ms`,
    `${s.p99Ms.toFixed(2)}ms`,
    `${s.maxMs.toFixed(2)}ms`,
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();

  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
