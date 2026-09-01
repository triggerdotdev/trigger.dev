import { UnknownShardKey } from "@internal/run-store";
import { logger } from "~/services/logger.server";

// An id naming a shard the topology has no store for cannot locate a row, so the caller's own
// not-found path is the right answer rather than a 500. Logged so a shard key dropped from a
// config meant to be append-only still alarms instead of reading as an absent run.
export async function undefinedOnUnroutableId<T>(
  read: Promise<T>,
  context: Record<string, unknown>
): Promise<T | undefined> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof UnknownShardKey) {
      logger.warn("Unroutable id treated as not found", { ...context, error: error.message });
      return undefined;
    }

    throw error;
  }
}
