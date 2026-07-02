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

// Strictly-monotonic-per-stream ordering key from a stream id (`<ms>-<seq>`): ms*1e5+seq.
// Used to order cumulative readings for deltaSumTimestamp so within-ms ties don't misorder.
export function entryOrderKey(id: string): number {
  const [ms, seq] = id.split("-");
  return (Number(ms) || 0) * 100000 + (Number(seq) || 0);
}
