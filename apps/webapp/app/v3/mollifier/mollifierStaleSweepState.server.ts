import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";

// Durable per-tick state for the sharded stale sweep. Four Redis keys,
// all in the `mollifier:` namespace alongside the buffer's own state:
//
//   mollifier:stale_sweep:cursor    STRING  next position in org_list (0 = fresh cycle)
//   mollifier:stale_sweep:org_list  LIST    org IDs frozen at the start of the cycle
//   mollifier:stale_sweep:counts    HASH    envId -> last-known stale count
//   mollifier:stale_sweep:visited   SET     envIds visited during the current cycle
//
// The state survives webapp restarts: a restarted process picks up the
// cursor where the previous one left off and re-emits the last-known
// gauge values immediately, rather than blinking to zero until the next
// cycle visits each env.
//
// The `visited` set exists to GC the `counts` hash at cycle wrap: an env
// that drains completely between sweep ticks disappears from
// `buffer.listEnvsForOrg`, so the sweep's inner loop never revisits it
// and never HDELs its counts entry. Without the visited-set GC the
// counts hash retains the env's last-known stale count forever and the
// gauge stays permanently elevated. At cursor wrap we diff the hash
// against the cycle's visited set and HDEL the difference.
//
// Storage is owned by this class rather than added to MollifierBuffer
// because the keys are sweep-internal — the buffer abstracts the
// drainer/queue state, this abstracts sweep state. They share a
// namespace prefix but no API surface.

export interface StaleSweepStateStore {
  readCursor(): Promise<number>;
  writeCursor(value: number): Promise<void>;
  /** Replaces the cycle's frozen org_list. Called at cursor=0. */
  rebuildOrgList(orgs: string[]): Promise<void>;
  /** Returns up to `count` org IDs starting at `start`, plus the LIST's total length. */
  readOrgListSlice(start: number, count: number): Promise<{ orgs: string[]; total: number }>;
  /** HSET when count > 0, HDEL when count === 0 (so the snapshot reflects current truth). */
  setEnvStaleCount(envId: string, count: number): Promise<void>;
  readAllEnvStaleCounts(): Promise<Map<string, number>>;
  /** SADD `envId` to the current cycle's visited set. Called once per env scanned per tick. */
  markEnvVisited(envId: string): Promise<void>;
  /**
   * HDEL every env in the counts hash that is NOT in the visited set, then
   * DEL the visited set. Called when the cursor wraps (cycle ends) so
   * envs that fully drained mid-cycle get cleaned out of the gauge.
   */
  reconcileVisited(): Promise<void>;
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

const CURSOR_KEY = "mollifier:stale_sweep:cursor";
const ORG_LIST_KEY = "mollifier:stale_sweep:org_list";
const COUNTS_KEY = "mollifier:stale_sweep:counts";
const VISITED_KEY = "mollifier:stale_sweep:visited";

export class MollifierStaleSweepState implements StaleSweepStateStore {
  private readonly redis: Redis;
  private readonly logger: Logger;

  constructor(options: { redisOptions: RedisOptions; logger?: Logger }) {
    this.logger = options.logger ?? new Logger("MollifierStaleSweepState", "debug");
    this.redis = createRedisClient(
      { ...options.redisOptions, maxRetriesPerRequest: 20 },
      {
        onError: (error) => {
          this.logger.error("MollifierStaleSweepState redis client error:", { error });
        },
      },
    );
  }

  async readCursor(): Promise<number> {
    const raw = await this.redis.get(CURSOR_KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  async writeCursor(value: number): Promise<void> {
    await this.redis.set(CURSOR_KEY, String(value));
  }

  async rebuildOrgList(orgs: string[]): Promise<void> {
    // DEL + RPUSH in a pipeline — close enough to atomic for an
    // observational sweep (the inFlight guard at startStaleSweepInterval
    // serialises sweep passes; nothing else writes these keys).
    const pipeline = this.redis.pipeline();
    pipeline.del(ORG_LIST_KEY);
    if (orgs.length > 0) {
      pipeline.rpush(ORG_LIST_KEY, ...orgs);
    }
    await pipeline.exec();
  }

  async readOrgListSlice(
    start: number,
    count: number,
  ): Promise<{ orgs: string[]; total: number }> {
    const pipeline = this.redis.pipeline();
    pipeline.lrange(ORG_LIST_KEY, start, start + count - 1);
    pipeline.llen(ORG_LIST_KEY);
    const results = await pipeline.exec();
    if (!results) return { orgs: [], total: 0 };
    const [lrangeErr, lrangeRes] = results[0] as [Error | null, string[] | null];
    const [llenErr, llenRes] = results[1] as [Error | null, number | null];
    if (lrangeErr || llenErr) {
      this.logger.error("MollifierStaleSweepState.readOrgListSlice failed", {
        lrangeErr: lrangeErr?.message,
        llenErr: llenErr?.message,
      });
      return { orgs: [], total: 0 };
    }
    return { orgs: lrangeRes ?? [], total: llenRes ?? 0 };
  }

  async setEnvStaleCount(envId: string, count: number): Promise<void> {
    if (count > 0) {
      await this.redis.hset(COUNTS_KEY, envId, String(count));
    } else {
      await this.redis.hdel(COUNTS_KEY, envId);
    }
  }

  async readAllEnvStaleCounts(): Promise<Map<string, number>> {
    const raw = await this.redis.hgetall(COUNTS_KEY);
    const out = new Map<string, number>();
    for (const [envId, value] of Object.entries(raw)) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.set(envId, n);
    }
    return out;
  }

  async markEnvVisited(envId: string): Promise<void> {
    await this.redis.sadd(VISITED_KEY, envId);
  }

  async reconcileVisited(): Promise<void> {
    // HKEYS + SMEMBERS in a pipeline, then HDEL the difference locally.
    // For typical fleet sizes (counts and visited both bounded by the
    // count of buffered envs) this is well within a single RTT plus one
    // small HDEL.
    const pipeline = this.redis.pipeline();
    pipeline.hkeys(COUNTS_KEY);
    pipeline.smembers(VISITED_KEY);
    const results = await pipeline.exec();
    if (!results) return;
    const [hkeysErr, hkeysRes] = results[0] as [Error | null, string[] | null];
    const [smembersErr, smembersRes] = results[1] as [Error | null, string[] | null];
    if (hkeysErr || smembersErr) {
      this.logger.error("MollifierStaleSweepState.reconcileVisited failed", {
        hkeysErr: hkeysErr?.message,
        smembersErr: smembersErr?.message,
      });
      return;
    }
    const hashEnvs = hkeysRes ?? [];
    const visited = new Set(smembersRes ?? []);
    const orphans = hashEnvs.filter((envId) => !visited.has(envId));
    const cleanup = this.redis.pipeline();
    if (orphans.length > 0) {
      cleanup.hdel(COUNTS_KEY, ...orphans);
    }
    cleanup.del(VISITED_KEY);
    await cleanup.exec();
  }

  async clearAll(): Promise<void> {
    await this.redis.del(CURSOR_KEY, ORG_LIST_KEY, COUNTS_KEY, VISITED_KEY);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
