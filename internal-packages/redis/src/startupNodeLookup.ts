import dns from "node:dns";
import type { Cluster } from "ioredis";
import { Logger } from "@trigger.dev/core/logger";

const logger = new Logger("Redis", "debug");

type LookupAddress = { address: string; family: number };
type ResolveAll = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

export type StartupNodeLookupOptions = {
  /** How long an address that failed is skipped for. */
  penaltyMs?: number;
  /** Only for tests that need a fixed address list. Production uses `dns.lookup`. */
  resolve?: ResolveAll;
  /** Only for tests: receives each summary that is logged when the client becomes ready. */
  onSkipSummary?: (summary: StartupNodeSkipSummary) => void;
};

/** What the lookup skipped while a client was connecting. */
export type StartupNodeSkipSummary = {
  hostname: string;
  /** The address of the attempt that got the client to ready. */
  chosen: string;
  skipped: string[];
  lookups: number;
};

/**
 * A cluster `dnsLookup` for a startup hostname that resolves to every node in the cluster (such as
 * a MemoryDB cluster endpoint). ioredis takes one address per connect attempt, and the default
 * lookup returns the first record, so a client whose first record is a dead node retries that node
 * and never reads the slot map. This picks a random address instead, and skips addresses that
 * recently failed, so the next attempt goes to a different node.
 */
export function createStartupNodeLookup({
  penaltyMs = 10_000,
  resolve = dns.lookup as unknown as ResolveAll,
}: StartupNodeLookupOptions = {}) {
  const failedAt = new Map<string, number>();
  // Since the last takeSkipSummary(), which the client calls on "ready".
  let lookups = 0;
  let lastHostname = "";
  let lastChosen = "";
  const skipped = new Set<string>();

  function dnsLookup(
    hostname: string,
    callback: (error: NodeJS.ErrnoException | null, address: string, family?: number) => void
  ) {
    resolve(hostname, { all: true }, (error, records) => {
      if (error) return callback(error, "");

      const now = Date.now();
      for (const [address, failedTime] of failedAt) {
        if (now - failedTime >= penaltyMs) failedAt.delete(address);
      }

      const usable = records.filter((record) => !failedAt.has(record.address));
      // Every address failed recently: trying one of them beats not trying at all.
      const candidates = usable.length > 0 ? usable : records;
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      if (!chosen) return callback(new Error(`No addresses found for ${hostname}`), "");

      lookups++;
      lastHostname = hostname;
      lastChosen = chosen.address;
      if (usable.length > 0) {
        for (const record of records) {
          if (failedAt.has(record.address)) skipped.add(record.address);
        }
      }
      callback(null, chosen.address, chosen.family);
    });
  }

  /** Takes an ioredis node key, `host:port`. */
  function markFailed(nodeKey: string) {
    const separator = nodeKey.lastIndexOf(":");
    const address = separator === -1 ? nodeKey : nodeKey.slice(0, separator);
    failedAt.set(address, Date.now());
  }

  /**
   * Returns what was skipped since the last call, or undefined if nothing was, and resets. Called
   * once per "ready", so an outage logs one line when the client gets in rather than one per
   * attempt; failed attempts are already reported by "node error".
   */
  function takeSkipSummary(): StartupNodeSkipSummary | undefined {
    const summary =
      skipped.size > 0
        ? { hostname: lastHostname, chosen: lastChosen, skipped: [...skipped], lookups }
        : undefined;
    lookups = 0;
    skipped.clear();
    return summary;
  }

  return { dnsLookup, markFailed, takeSkipSummary };
}

/**
 * ioredis < 6.1.0 can leave a cluster in "close" with no retry scheduled: if its last node
 * connection ends while connect() waits on the startup-node lookup, connect() rejects with
 * "Connection is aborted" and nothing reconnects. A normal close moves to "reconnecting" at once,
 * so "close" held for longer than the cluster's largest retry delay means nothing will reconnect,
 * and this calls connect() itself.
 *
 * `maxRetryDelayMs` must stay above the cluster retry strategy's largest delay (the default
 * `clusterRetryStrategy` caps at 2000 ms); otherwise this races a reconnect ioredis already
 * scheduled.
 */
export function keepClusterConnecting(
  cluster: Cluster,
  { maxRetryDelayMs = 2_000, checkIntervalMs = 250 } = {}
) {
  let closeSince: number | undefined;

  const timer = setInterval(() => {
    if (cluster.status !== "close") {
      closeSince = undefined;
      return;
    }
    closeSince ??= Date.now();
    const closedForMs = Date.now() - closeSince;
    if (closedForMs <= maxRetryDelayMs + 250) return;
    closeSince = undefined;
    logger.warn("Reconnecting a Redis cluster client left in close with no retry scheduled", {
      closedForMs,
    });
    cluster.connect().catch(() => {});
  }, checkIntervalMs);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    cluster.off("end", stop);
  };
  cluster.on("end", stop);

  // Once the owner closes the client it must stay closed. "end" alone is not enough: a node socket
  // that ends after a close ioredis already handled sets "close" again without "end", and a close
  // from a non-ready status may never reach "end". ioredis's own reconnects call disconnect(true),
  // so only a close without reconnect stops the guard.
  const quit = cluster.quit.bind(cluster);
  const disconnect = cluster.disconnect.bind(cluster);
  cluster.quit = ((...args: Parameters<Cluster["quit"]>) => {
    stop();
    return quit(...args);
  }) as Cluster["quit"];
  cluster.disconnect = (reconnect = false) => {
    if (!reconnect) stop();
    return disconnect(reconnect);
  };

  return stop;
}
