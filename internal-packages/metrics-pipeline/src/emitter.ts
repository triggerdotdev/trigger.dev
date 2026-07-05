import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { getMeter, type Counter, type Meter, ValueType } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { shardFor } from "./hash.js";
import { streamKey, type MetricDefinition, type MetricFields } from "./types.js";

export type MetricsStreamEmitterOptions = {
  redis: RedisOptions;
  definition: MetricDefinition;
  /** Synchronous enabled check (e.g. CachedRedisFlag); emits are no-ops when false. */
  flag: { enabled(): boolean };
  /** Probability (0..1) that a sampled emission fires; applies to `sampledSync()`, not
   * `emit()`. Pass a `{ value() }` provider (e.g. CachedRedisNumber) to tune it live
   * without a redeploy. Default 1 (always). */
  gaugeSampleRate?: number | { value(): number };
  /** TTL (ms) refreshed on every counter write on the per-(queue,op) odometer key.
   * Active queues never expire; idle-past-TTL queues purge and self-heal on return.
   * Default 7 days. */
  counterOdometerTtlMs?: number;
  /** TTL (ms) for per-concurrency-key odometers; short because key cardinality is
   * user-controlled and cumulative counters make idle-gap expiry loss-free. Default 24h. */
  ckOdometerTtlMs?: number;
  logger?: Logger;
  meter?: Meter;
};

type CumulativeCommand = (
  odometerKey: string,
  streamKey: string,
  ttlMs: string,
  maxLen: string,
  op: string,
  q: string,
  ...extraFields: string[]
) => Promise<unknown>;

type CumulativeCkCommand = (
  odometerKey: string,
  ckOdometerKey: string,
  streamKey: string,
  ttlMs: string,
  ckTtlMs: string,
  maxLen: string,
  op: string,
  q: string,
  ck: string,
  ...extraFields: string[]
) => Promise<unknown>;

// INCR the odometer, refresh its TTL, and XADD the reading (new value as `cum`) in one round
// trip. Refresh-on-write is load-bearing: only genuinely idle queues expire. On first creation
// (v==1) XADD a cum=0 baseline first (smaller stream id => sorts first) so deltaSum captures the
// 0->1 transition and the total reconstructs exactly.
// ARGV: [1]=ttlMs [2]=maxLen [3]=op [4]=q [5..]=extra field/value pairs (e.g. wait).
const CUMULATIVE_LUA = `
local v = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
local maxlen = tonumber(ARGV[2]) or 0
local function xadd(cum, withExtra)
  local x = {'XADD', KEYS[2]}
  if maxlen > 0 then x[#x+1]='MAXLEN'; x[#x+1]='~'; x[#x+1]=ARGV[2] end
  x[#x+1]='*'
  x[#x+1]='op'; x[#x+1]=ARGV[3]
  x[#x+1]='q';  x[#x+1]=ARGV[4]
  if withExtra then for i=5,#ARGV do x[#x+1]=ARGV[i] end end
  x[#x+1]='cum'; x[#x+1]=cum
  redis.call(unpack(x))
end
if v == 1 then xadd(0, false) end
xadd(v, true)
`;

// CK variant: advances base + per-key odometers, ONE reading entry carries both (cum +
// ck/ckcum), so per-key attribution adds no stream volume. Baselines seed independently:
// cum-only entry = base row, ck+ckcum-only entry = per-key row, reading entry = both.
// KEYS: [1]=baseOdometer [2]=ckOdometer [3]=stream. ARGV: [1]=baseTtlMs [2]=ckTtlMs
// [3]=maxLen [4]=op [5]=q [6]=ck [7..]=extra field/value pairs.
const CUMULATIVE_CK_LUA = `
local v = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
local ckv = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
local maxlen = tonumber(ARGV[3]) or 0
local function xadd(fields, withExtra)
  local x = {'XADD', KEYS[3]}
  if maxlen > 0 then x[#x+1]='MAXLEN'; x[#x+1]='~'; x[#x+1]=ARGV[3] end
  x[#x+1]='*'
  x[#x+1]='op'; x[#x+1]=ARGV[4]
  x[#x+1]='q';  x[#x+1]=ARGV[5]
  if withExtra then for i=7,#ARGV do x[#x+1]=ARGV[i] end end
  for i=1,#fields do x[#x+1]=fields[i] end
  redis.call(unpack(x))
end
if v == 1 then xadd({'cum', 0}, false) end
if ckv == 1 then xadd({'ck', ARGV[6], 'ckcum', 0}, false) end
xadd({'ck', ARGV[6], 'cum', v, 'ckcum', ckv}, true)
`;

/** Node-side producer: XADDs events to a sharded metrics stream, gated on a flag. */
export class MetricsStreamEmitter {
  private readonly redis: Redis;
  private readonly def: MetricDefinition;
  private readonly flag: { enabled(): boolean };
  private readonly sampleRate: () => number;
  private readonly odometerTtlMs: number;
  private readonly ckOdometerTtlMs: number;
  private readonly logger: Logger;
  private readonly emittedCounter: Counter;
  private readonly errorCounter: Counter;

  constructor(options: MetricsStreamEmitterOptions) {
    this.logger = options.logger ?? new Logger("MetricsStreamEmitter", "warn");
    this.redis = createRedisClient(
      { ...options.redis, keyPrefix: undefined },
      { onError: (error) => this.logger.error("emitter redis error", { error }) }
    );
    this.redis.defineCommand("qmEmitCumulative", { numberOfKeys: 2, lua: CUMULATIVE_LUA });
    this.redis.defineCommand("qmEmitCumulativeCk", { numberOfKeys: 3, lua: CUMULATIVE_CK_LUA });
    this.odometerTtlMs = options.counterOdometerTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.ckOdometerTtlMs = options.ckOdometerTtlMs ?? 24 * 60 * 60 * 1000;
    this.def = options.definition;
    this.flag = options.flag;
    const rate = options.gaugeSampleRate;
    if (typeof rate === "object") {
      this.sampleRate = () => rate.value();
    } else {
      const fixed = Math.min(1, Math.max(0, rate ?? 1));
      this.sampleRate = () => fixed;
    }

    const meter = options.meter ?? getMeter("metrics-pipeline");
    this.emittedCounter = meter.createCounter("queue_metrics.emitter.emitted", {
      description: "Node-side metric events XADDed to the stream",
      valueType: ValueType.INT,
    });
    this.errorCounter = meter.createCounter("queue_metrics.emitter.errors", {
      description: "Failed metric-event XADDs (dropped)",
      valueType: ValueType.INT,
    });
  }

  enabledSync(): boolean {
    return this.flag.enabled();
  }

  // Enabled AND (probabilistically) sampled-in. For high-frequency sampled emissions
  // (e.g. Lua gauges); exact-count events use enabledSync()/emit() and are never sampled.
  sampledSync(): boolean {
    if (!this.flag.enabled()) return false;
    const rate = this.sampleRate();
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }

  // Fire-and-forget gauge emit: a plain XADD of an op=gauge snapshot (no odometer). The
  // gauge value was read atomically inside the queue op's Lua and returned on the reply;
  // this just lands it on the metrics stream. Loss-tolerant (sampled), never throws into
  // the caller. Shares the counter stream (one stream family on the metrics Redis).
  emitGauge(shardKey: string, fields: MetricFields): void {
    if (!this.flag.enabled()) return;
    // Drop rather than queue while the metrics Redis is unreachable: ioredis would hold
    // every command in its offline queue until rejection, and metrics are loss-tolerant.
    if (this.redis.status !== "ready") return;
    const op = String(fields.op ?? "gauge");
    const stream = streamKey(this.def, shardFor(shardKey, this.def.shardCount));
    const args: string[] = [];
    if (this.def.maxLen) args.push("MAXLEN", "~", String(this.def.maxLen));
    args.push("*");
    for (const [field, value] of Object.entries(fields)) {
      args.push(field, String(value));
    }
    this.emittedCounter.add(1, { op });
    this.redis.xadd(stream, ...(args as [string, ...string[]])).catch((error) => {
      this.errorCounter.add(1);
      this.logger.debug("metrics gauge emit failed", { error, stream });
    });
  }

  // Fire-and-forget cumulative counter emit: advances the per-(queue,op) odometer and
  // XADDs its new absolute value. No-op when disabled, never throws into the caller. A
  // lost XADD self-heals (the next reading restates the total); the INCR is never sampled.
  // A non-empty `fields.ck` also advances a per-concurrency-key odometer and rides the
  // same entry as ck/ckcum (see CUMULATIVE_CK_LUA for the baseline/row mapping).
  emit(shardKey: string, fields: MetricFields): void {
    if (!this.flag.enabled()) return;
    if (this.redis.status !== "ready") return;
    const op = String(fields.op ?? "unknown");
    const q = String(fields.q ?? "");
    const ck = fields.ck != null && String(fields.ck) !== "" ? String(fields.ck) : null;
    const shard = shardFor(shardKey, this.def.shardCount);
    const stream = streamKey(this.def, shard);
    // The odometer carries the stream's {shard} hash tag so INCR + XADD stay in one
    // Cluster slot (the shard is derived from the queue, so the mapping is stable).
    // The key format is part of the rolling-deploy data shape: concurrent old/new
    // emitters with different formats split an odometer and corrupt its deltas.
    const odometerKey = `${this.def.name}_cum:{${shard}}:${op}:${q}`;
    const extra: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (field === "op" || field === "q" || field === "ck") continue;
      extra.push(field, String(value));
    }
    this.emittedCounter.add(1, { op });
    const maxLen = String(this.def.maxLen ?? 0);
    const done = (error: unknown) => {
      this.errorCounter.add(1);
      this.logger.debug("metrics emit failed", { error, stream });
    };
    if (ck) {
      const client = this.redis as unknown as { qmEmitCumulativeCk: CumulativeCkCommand };
      client
        .qmEmitCumulativeCk(
          odometerKey,
          `${odometerKey}:ck:${ck}`,
          stream,
          String(this.odometerTtlMs),
          String(this.ckOdometerTtlMs),
          maxLen,
          op,
          q,
          ck,
          ...extra
        )
        .catch(done);
      return;
    }
    const client = this.redis as unknown as { qmEmitCumulative: CumulativeCommand };
    client
      .qmEmitCumulative(odometerKey, stream, String(this.odometerTtlMs), maxLen, op, q, ...extra)
      .catch(done);
  }

  // Resolves once the metrics Redis connection is ready (emits before that are dropped).
  waitUntilReady(): Promise<void> {
    if (this.redis.status === "ready") return Promise.resolve();
    return new Promise((resolve) => this.redis.once("ready", () => resolve()));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
