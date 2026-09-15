import { type QueueMetricsRawV1Input } from "@internal/clickhouse";
import { entryOrderKey, entryTimeMs, type StreamEntry } from "@internal/metrics-pipeline";

const OPS = new Set(["gauge", "enqueue", "started", "ack", "nack", "dlq"]);

// {org:ORGID}:proj:PROJECTID:env:ENVID:queue:QUEUENAME[:ck:CK]. Anchored (not a
// positional split) so a queue name containing ":" survives; the lazy name capture
// stops before an optional ":ck:" suffix, which is captured (the ":ck:*" wildcard of
// aggregate CK-dequeue gauges maps to no key).
const DESCRIPTOR = /^\{org:([^}]+)\}:proj:([^:]+):env:([^:]+):queue:(.+?)(?::ck:(.+))?$/;

export function descriptorFromQueue(q: string): {
  organization_id: string;
  project_id: string;
  environment_id: string;
  queue_name: string;
  concurrency_key: string;
} | null {
  const match = DESCRIPTOR.exec(q);
  if (!match) return null;
  const ck = match[5];
  return {
    organization_id: match[1]!,
    project_id: match[2]!,
    environment_id: match[3]!,
    queue_name: match[4]!,
    concurrency_key: ck && ck !== "*" ? ck : "",
  };
}

export const OVERFLOW_QUEUE_NAME = "__overflow__";

/**
 * Bounds per-scope name cardinality (both queue_name per env and concurrency_key per
 * queue are user-controlled GROUP BY keys). Names beyond the cap map to OVERFLOW_QUEUE_NAME.
 * Per-process and reset on restart, so the cap is approximate: a protective bound, not a quota.
 */
export class QueueNameLimiter {
  private readonly byScope = new Map<string, Set<string>>();

  constructor(
    private readonly maxPerScope: number,
    private readonly maxScopes = 10_000
  ) {}

  limit(scope: string, name: string): string {
    if (this.maxPerScope <= 0) return name;
    let names = this.byScope.get(scope);
    if (!names) {
      if (this.byScope.size >= this.maxScopes) {
        const oldest = this.byScope.keys().next().value;
        if (oldest !== undefined) this.byScope.delete(oldest);
      }
      names = new Set();
      this.byScope.set(scope, names);
    }
    if (names.has(name)) return name;
    if (names.size >= this.maxPerScope) return OVERFLOW_QUEUE_NAME;
    names.add(name);
    return name;
  }
}

function num(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export type QueueMetricsLimiters = {
  queueNames?: QueueNameLimiter;
  concurrencyKeys?: QueueNameLimiter;
};

/**
 * One stream entry maps to 1..2 raw rows: gauges are single rows carrying their parsed
 * concurrency_key; a counter entry yields a base row when `cum` is present plus a per-key
 * row when `ck`/`ckcum` are present (the emitter's dual-odometer entry). Baseline entries
 * carry only one of the two, by design.
 */
export function mapEntryToRows(
  entry: StreamEntry,
  limiters?: QueueMetricsLimiters
): QueueMetricsRawV1Input[] {
  const f = entry.fields;
  const op = f.op;
  if (!op || !OPS.has(op) || !f.q) return [];
  const descriptor = descriptorFromQueue(f.q);
  if (!descriptor || !descriptor.queue_name) return [];

  let queueOverflowed = false;
  if (limiters?.queueNames) {
    descriptor.queue_name = limiters.queueNames.limit(
      descriptor.environment_id,
      descriptor.queue_name
    );
    queueOverflowed = descriptor.queue_name === OVERFLOW_QUEUE_NAME;
  }

  // Counter entries carry the key as a field (q is base-normalized); gauges carry it in q.
  let ck = descriptor.concurrency_key || (typeof f.ck === "string" ? f.ck : "");
  if (ck && limiters?.concurrencyKeys) {
    const scope = `${descriptor.environment_id}:${descriptor.queue_name}`;
    if (limiters.concurrencyKeys.limit(scope, ck) === OVERFLOW_QUEUE_NAME) ck = "";
  }
  // Overflowed queue names share one row; per-key attribution under them is meaningless.
  if (queueOverflowed) ck = "";

  const eventMs = entryTimeMs(entry.id) ?? Date.now();
  const eventTime = new Date(eventMs).toISOString().slice(0, 19).replace("T", " ");
  const base = {
    organization_id: descriptor.organization_id,
    project_id: descriptor.project_id,
    environment_id: descriptor.environment_id,
    queue_name: descriptor.queue_name,
    event_time: eventTime,
    op: op as QueueMetricsRawV1Input["op"],
  };

  if (op === "gauge") {
    return [
      {
        ...base,
        concurrency_key: ck,
        queued: num(f.ql),
        running: num(f.cc),
        queue_limit: num(f.lim),
        env_queued: num(f.eql),
        env_running: num(f.ec),
        env_limit: num(f.elim),
        throttled: num(f.thr),
        ck_backlogged: num(f.ckq),
        ck_max_wait_ms: num(f.ckw),
      },
    ];
  }

  // Overflowed names drop counters entirely: merging distinct odometers under one shared
  // name produces garbage deltas (gauges above stay, max across the overflow set is
  // still meaningful).
  if (queueOverflowed) return [];

  const rows: QueueMetricsRawV1Input[] = [];
  const orderKey = entryOrderKey(entry.id);
  const waitMs = op === "started" && f.wait != null ? num(f.wait) : undefined;
  if (f.cum != null) {
    rows.push({
      ...base,
      cumulative: num(f.cum),
      order_key: orderKey,
      ...(waitMs !== undefined ? { wait_ms: waitMs } : {}),
    });
  }
  if (ck && f.ckcum != null) {
    rows.push({
      ...base,
      concurrency_key: ck,
      cumulative: num(f.ckcum),
      order_key: orderKey,
      ...(waitMs !== undefined ? { wait_ms: waitMs } : {}),
    });
  }
  return rows;
}
