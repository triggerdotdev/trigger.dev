// Per-command call counts from `INFO commandstats`. The counts are per server: the test Redis is a
// single node, so they cover every command any client sent it. Against a cluster, sum each master.
import type { RedisClient } from "@internal/redis";

export type CommandCalls = Record<string, number>;

export async function commandCalls(client: RedisClient): Promise<CommandCalls> {
  const info = await client.info("commandstats");
  const calls: CommandCalls = {};
  for (const line of info.split(/\r?\n/)) {
    const match = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
    if (match) calls[match[1]] = Number(match[2]);
  }
  return calls;
}

/** How many times `command` ran between two snapshots. */
export function callsBetween(before: CommandCalls, after: CommandCalls, command: string): number {
  return (after[command] ?? 0) - (before[command] ?? 0);
}
