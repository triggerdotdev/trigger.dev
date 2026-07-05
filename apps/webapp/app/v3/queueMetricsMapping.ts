import { type QueueMetricsRawV1Input } from "@internal/clickhouse";
import { entryOrderKey, entryTimeMs, type StreamEntry } from "@internal/metrics-pipeline";

const OPS = new Set(["gauge", "enqueue", "started", "ack", "nack", "dlq"]);

// {org:ORGID}:proj:PROJECTID:env:ENVID:queue:QUEUENAME[:ck:CK]. Anchored (not a
// positional split) so a queue name containing ":" survives; the lazy name capture
// stops before an optional ":ck:" suffix.
const DESCRIPTOR = /^\{org:([^}]+)\}:proj:([^:]+):env:([^:]+):queue:(.+?)(?::ck:.+)?$/;

export function descriptorFromQueue(q: string): {
  organization_id: string;
  project_id: string;
  environment_id: string;
  queue_name: string;
} | null {
  const match = DESCRIPTOR.exec(q);
  if (!match) return null;
  return {
    organization_id: match[1]!,
    project_id: match[2]!,
    environment_id: match[3]!,
    queue_name: match[4]!,
  };
}

export const OVERFLOW_QUEUE_NAME = "__overflow__";

/**
 * Bounds per-environment queue_name cardinality (queue_name is user-controlled and is a
 * GROUP BY key in the aggregated table). Names beyond the cap map to OVERFLOW_QUEUE_NAME.
 * Per-process and reset on restart, so the cap is approximate: a protective bound, not a quota.
 */
export class QueueNameLimiter {
  private readonly byEnv = new Map<string, Set<string>>();

  constructor(
    private readonly maxPerEnv: number,
    private readonly maxEnvs = 10_000
  ) {}

  limit(environmentId: string, queueName: string): string {
    if (this.maxPerEnv <= 0) return queueName;
    let names = this.byEnv.get(environmentId);
    if (!names) {
      if (this.byEnv.size >= this.maxEnvs) {
        const oldest = this.byEnv.keys().next().value;
        if (oldest !== undefined) this.byEnv.delete(oldest);
      }
      names = new Set();
      this.byEnv.set(environmentId, names);
    }
    if (names.has(queueName)) return queueName;
    if (names.size >= this.maxPerEnv) return OVERFLOW_QUEUE_NAME;
    names.add(queueName);
    return queueName;
  }
}

function num(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function mapEntryToRow(
  entry: StreamEntry,
  limiter?: QueueNameLimiter
): QueueMetricsRawV1Input | null {
  const f = entry.fields;
  const op = f.op;
  if (!op || !OPS.has(op) || !f.q) return null;
  const descriptor = descriptorFromQueue(f.q);
  if (!descriptor || !descriptor.queue_name) return null;
  if (limiter) {
    descriptor.queue_name = limiter.limit(descriptor.environment_id, descriptor.queue_name);
    // Overflowed names share one row, but counter readings are per-queue odometers and
    // merging different odometers under one key produces garbage deltas: drop counters
    // for overflow, keep gauges (max across the overflow set is still meaningful).
    if (descriptor.queue_name === OVERFLOW_QUEUE_NAME && op !== "gauge") return null;
  }

  const eventMs = entryTimeMs(entry.id) ?? Date.now();
  const row: QueueMetricsRawV1Input = {
    ...descriptor,
    event_time: new Date(eventMs).toISOString().slice(0, 19).replace("T", " "),
    op: op as QueueMetricsRawV1Input["op"],
  };

  if (op === "gauge") {
    row.queued = num(f.ql);
    row.running = num(f.cc);
    row.queue_limit = num(f.lim);
    row.env_queued = num(f.eql);
    row.env_running = num(f.ec);
    row.env_limit = num(f.elim);
    row.throttled = num(f.thr);
  } else {
    // Counter op: the monotonic odometer reading + its ordering key (and wait on started).
    row.cumulative = num(f.cum);
    row.order_key = entryOrderKey(entry.id);
    if (op === "started" && f.wait != null) row.wait_ms = num(f.wait);
  }
  return row;
}
