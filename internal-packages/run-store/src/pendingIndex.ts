import type { RedisClient } from "@internal/redis";
import {
  PENDING_PARTITION_COUNT,
  pendingStreamKey,
  pendingStreamKeyForRun,
} from "./snapshotKeys.js";

/**
 * The recovery sweep's consumer group on every partition stream. The sweep holds one fleet-wide
 * lease (`recoveryLeaseKey`), not a lease per partition. Group delivery, XAUTOCLAIM,
 * transition-token idempotency and the atomic finalize, abort and settle make a redelivery after a
 * crash or a lease handover harmless.
 */
export const RECOVERY_CONSUMER_GROUP = "snap-recovery";

export type PendingEntry = { id: string; fields: Record<string, string> };

/**
 * The per-partition pending streams. The prepare Lua adds an entry, and finalize and abort
 * delete it. The recovery sweep consumes the streams, and the depth gauges read {@link summary}.
 */
export class PendingIndex {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Idempotent. The group starts at `0`, not `$`, so a sweep that starts after units were prepared
   * still gets the whole unresolved backlog.
   */
  async ensureGroup(partition: number): Promise<void> {
    try {
      await this.redis.xgroup(
        "CREATE",
        pendingStreamKey(partition),
        RECOVERY_CONSUMER_GROUP,
        "0",
        "MKSTREAM"
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("BUSYGROUP")) return;
      throw error;
    }
  }

  async ensureAllGroups(): Promise<void> {
    for (let partition = 0; partition < PENDING_PARTITION_COUNT; partition++) {
      await this.ensureGroup(partition);
    }
  }

  async add(runId: string, fields: Record<string, string>): Promise<string> {
    const args: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      args.push(key, value);
    }
    return (await this.redis.xadd(pendingStreamKeyForRun(runId), "*", ...args)) as string;
  }

  /** Unresolved unit count and oldest unit age, for the recovery gauges. Never a full scan. */
  async summary(partition: number): Promise<{ count: number; oldestMs?: number }> {
    const key = pendingStreamKey(partition);
    const [len, first] = await Promise.all([
      this.redis.xlen(key),
      this.redis.xrange(key, "-", "+", "COUNT", 1) as Promise<Array<[string, string[]]>>,
    ]);
    const oldestId = first[0]?.[0];
    const oldestMs = oldestId ? Number(oldestId.split("-")[0]) : undefined;
    return { count: len as number, oldestMs };
  }

  async enumerate(partition: number): Promise<PendingEntry[]> {
    const rows = (await this.redis.xrange(pendingStreamKey(partition), "-", "+")) as Array<
      [string, string[]]
    >;
    return rows.map(([id, flat]) => toEntry(id, flat));
  }

  /** Delivered entries stay pending until settled, so {@link autoclaim} can reclaim them. */
  async readGroup(partition: number, consumer: string, count = 64): Promise<PendingEntry[]> {
    const reply = (await this.redis.xreadgroup(
      "GROUP",
      RECOVERY_CONSUMER_GROUP,
      consumer,
      "COUNT",
      count,
      "STREAMS",
      pendingStreamKey(partition),
      ">"
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!reply) return [];
    const stream = reply.find(([key]) => key === pendingStreamKey(partition));
    return (stream?.[1] ?? []).map(([id, flat]) => toEntry(id, flat));
  }

  /**
   * Reclaims entries idle for more than `minIdleMs`. With the idempotent finalize and abort, this
   * gives at-least-once recovery across crashes and lease handovers.
   */
  async autoclaim(
    partition: number,
    consumer: string,
    minIdleMs: number,
    cursor = "0",
    count = 64
  ): Promise<{ cursor: string; entries: PendingEntry[] }> {
    // Callers must pass the returned cursor to the next call. Always "0" rescans only the front of
    // a large pending list and starves later entries.
    const reply = (await this.redis.xautoclaim(
      pendingStreamKey(partition),
      RECOVERY_CONSUMER_GROUP,
      consumer,
      minIdleMs,
      cursor,
      "COUNT",
      count
    )) as unknown[];
    const nextCursor = typeof reply[0] === "string" ? reply[0] : "0";
    const rows = (reply[1] ?? []) as Array<[string, string[]]>;
    return { cursor: nextCursor, entries: rows.map(([id, flat]) => toEntry(id, flat)) };
  }

  /**
   * XACK and XDEL in one script, so a crash cannot leave an entry acked but not deleted, or the
   * reverse. Idempotent. Finalize and abort delete their own entries. This removes the entries
   * that stay after other outcomes, for example a quarantine, so the stream stays bounded.
   */
  async settle(partition: number, id: string): Promise<void> {
    await this.redis.eval(
      "redis.call('XACK', KEYS[1], ARGV[1], ARGV[2]); redis.call('XDEL', KEYS[1], ARGV[2]); return 1",
      1,
      pendingStreamKey(partition),
      RECOVERY_CONSUMER_GROUP,
      id
    );
  }
}

function toEntry(id: string, flat: string[] | null): PendingEntry {
  const fields: Record<string, string> = {};
  const pairs = flat ?? [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    fields[pairs[i]] = pairs[i + 1];
  }
  return { id, fields };
}
