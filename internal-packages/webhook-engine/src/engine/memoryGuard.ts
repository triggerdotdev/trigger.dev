import { Cluster, type Redis, type RedisClient } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";

/**
 * Tracks how full each primary of the webhooks Redis is, read from `INFO memory` on an interval, so
 * ingest can refuse new deliveries for a shard whose primary is past the high-water mark before
 * Redis itself starts refusing writes. With `noeviction`, a full primary refuses every enqueue and
 * front-gate claim on it, for every tenant, so stopping short keeps the rest of the node working.
 */
export class QueueMemoryGuard {
  readonly #usage = new Map<string, number>();
  #timer?: NodeJS.Timeout;

  constructor(
    private readonly client: RedisClient,
    private readonly options: { highWater: number; intervalMs: number; logger: Logger }
  ) {}

  start() {
    if (this.#timer) return;
    const refresh = () =>
      this.#refresh().catch((error: unknown) =>
        this.options.logger.warn("Couldn't read webhooks Redis memory", {
          error: error instanceof Error ? error.message : String(error),
        })
      );
    void refresh();
    this.#timer = setInterval(refresh, this.options.intervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Whether the primary serving `slot` is past the high-water mark, as of the last read. */
  isFull(slot: number): boolean {
    const node =
      this.client instanceof Cluster ? this.client.slots[slot]?.[0] : nodeKey(this.client);
    return node !== undefined && (this.#usage.get(node) ?? 0) >= this.options.highWater;
  }

  async #refresh() {
    const nodes = this.client instanceof Cluster ? this.client.nodes("master") : [this.client];
    await Promise.all(
      nodes.map(async (node) => {
        const usage = memoryUsage(await node.info("memory"));
        if (usage === undefined) this.#usage.delete(nodeKey(node));
        else this.#usage.set(nodeKey(node), usage);
      })
    );
  }
}

function nodeKey(node: Redis) {
  return `${node.options.host}:${node.options.port}`;
}

/** `used_memory / maxmemory`, or undefined when the node has no memory limit. */
function memoryUsage(info: string): number | undefined {
  const used = Number(/^used_memory:(\d+)/m.exec(info)?.[1]);
  const max = Number(/^maxmemory:(\d+)/m.exec(info)?.[1]);
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return undefined;
  return used / max;
}
