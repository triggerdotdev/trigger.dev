import { Counter, Gauge, type Registry } from "prom-client";

/** Prometheus metrics for dequeue backpressure. */
export class BackpressureMetrics {
  /** 1 while backpressure is engaged (computed signal, set even in dry-run). */
  readonly engaged: Gauge<string>;
  /** 1 when running in dry-run (gates inert). */
  readonly dryRun: Gauge<string>;
  /** Dequeue attempts the gate skipped - or would have, in dry-run (labelled). */
  readonly skipsTotal: Counter<string>;

  constructor(opts: { register: Registry; prefix?: string }) {
    const prefix = opts.prefix ?? "supervisor_backpressure";

    this.engaged = new Gauge({
      name: `${prefix}_engaged`,
      help: "1 while dequeue backpressure is engaged (computed signal, regardless of dry-run)",
      registers: [opts.register],
    });

    this.dryRun = new Gauge({
      name: `${prefix}_dry_run`,
      help: "1 when dequeue backpressure is in dry-run mode (gates inert)",
      registers: [opts.register],
    });

    this.skipsTotal = new Counter({
      name: `${prefix}_skipped_dequeues_total`,
      help: "Dequeue attempts skipped by backpressure (or would be, in dry-run)",
      labelNames: ["dry_run"],
      registers: [opts.register],
    });
  }
}
