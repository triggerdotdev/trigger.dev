export type MetricFields = Record<string, string | number>;

export type StreamEntry = {
  id: string;
  fields: Record<string, string>;
};

export type MetricDefinition = {
  /** Logical name, e.g. "queue_metrics". Used as the stream key prefix. */
  name: string;
  shardCount: number;
  consumerGroup: string;
  /** Approximate MAXLEN cap applied on XADD (`MAXLEN ~ N`). Omit for unbounded. */
  maxLen?: number;
};

// Keys are used verbatim on every access path (Lua ARGV, emitter, consumer), so
// they must NOT be subject to an ioredis keyPrefix. `{shard}` is a Cluster hash tag.
export function streamKey(definition: Pick<MetricDefinition, "name">, shard: number): string {
  return `${definition.name}:{${shard}}`;
}

export function allStreamKeys(definition: MetricDefinition): string[] {
  return Array.from({ length: Math.max(1, definition.shardCount) }, (_, shard) =>
    streamKey(definition, shard)
  );
}

// The ms part of a stream entry id is its emission time.
export function entryTimeMs(id: string): number | null {
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) ? ms : null;
}

// Ordering key from a stream id (`<ms>-<seq>`) = ms*1e6+seq, for deltaSumTimestamp. BigInt +
// string because ms*1e6 exceeds JS safe-integer range at real epoch magnitudes (a number would
// collapse nearby seq values); the ClickHouse order_key column is UInt64 and takes the string.
// The 1e6 factor (1M entries/ms/shard, far above any single Redis stream) stays within UInt64.
export function entryOrderKey(id: string): string {
  const [ms, seq] = id.split("-");
  return (BigInt(Number(ms) || 0) * 1000000n + BigInt(Number(seq) || 0)).toString();
}
