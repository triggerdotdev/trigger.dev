import type { RedisClient } from "@internal/redis";
import {
  PENDING_PARTITION_COUNT,
  pendingStreamKey,
  pendingStreamKeyForRun,
} from "./snapshotKeys.js";

/**
 * The one consumer group the recovery workers join on every partition stream. Delivery through the
 * group plus XAUTOCLAIM, transition-token idempotency, and atomic finalize give "exactly one
 * effective owner" as an emergent property, so no exclusive partition lease is built (M4).
 */
export const RECOVERY_CONSUMER_GROUP = "snap-recovery";

export type PendingEntry = { id: string; fields: Record<string, string> };

/**
 * Scaffolding for the pending-index topology (M2): the per-partition recovery streams with a consumer
 * group each, plus add/enumerate primitives. NO recovery worker and NO prepare protocol here — those
 * are M3/M4. The stream key derivation is fixed here so the Lua primitives can hard-code it later.
 */
export class PendingIndex {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Idempotently create a partition's pending stream and its consumer group. MKSTREAM creates an
   * empty stream if absent; a repeat call returns BUSYGROUP, which is swallowed. The group starts at
   * `0` (not `$`) so a recovery role that boots AFTER units are already prepared still consumes the
   * whole unresolved backlog — finalize/abort remove their stream entries, so only unresolved units
   * remain to re-deliver.
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

  /** Create the consumer group on every one of the fixed 256 partition streams. */
  async ensureAllGroups(): Promise<void> {
    for (let partition = 0; partition < PENDING_PARTITION_COUNT; partition++) {
      await this.ensureGroup(partition);
    }
  }

  /** Add one entry to the run's partition pending stream, returning the stream id. */
  async add(runId: string, fields: Record<string, string>): Promise<string> {
    const args: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      args.push(key, value);
    }
    return (await this.redis.xadd(pendingStreamKeyForRun(runId), "*", ...args)) as string;
  }

  /**
   * A cheap depth/age summary for a partition's pending stream, for the recovery gauges: the number of
   * still-unresolved prepared units (stream length; finalize/abort remove them) and the wall-clock ms
   * of the oldest one, taken from its stream id. Two O(1) reads, never a full scan.
   */
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

  /** Enumerate a partition's pending entries in insertion order. */
  async enumerate(partition: number): Promise<PendingEntry[]> {
    const rows = (await this.redis.xrange(pendingStreamKey(partition), "-", "+")) as Array<
      [string, string[]]
    >;
    return rows.map(([id, flat]) => toEntry(id, flat));
  }

  /**
   * Deliver a partition's never-yet-delivered entries to this consumer via the recovery group. The
   * entries move into the consumer's pending-entries list until XACKed, so a crash before ACK leaves
   * them reclaimable by {@link autoclaim} (M4).
   */
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
   * Re-claim entries a dead or slow consumer left pending past `minIdleMs`, reassigning them to this
   * consumer. Together with idempotent finalize/abort this gives at-least-once recovery without an
   * exclusive partition lease (M4).
   */
  async autoclaim(
    partition: number,
    consumer: string,
    minIdleMs: number,
    cursor = "0",
    count = 64
  ): Promise<{ cursor: string; entries: PendingEntry[] }> {
    // XAUTOCLAIM scans at most `count` entries per call starting at `cursor` and returns the next
    // cursor to resume from; passing "0" every time re-scans only the front of a large PEL and can
    // starve later entries. Thread the returned cursor across recovery passes (Redis returns "0" at
    // the end, which wraps naturally to the beginning).
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

  /** Idempotently acknowledge one entry, removing it from the recovery group's pending list. */
  async ack(partition: number, id: string): Promise<void> {
    await this.redis.xack(pendingStreamKey(partition), RECOVERY_CONSUMER_GROUP, id);
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
