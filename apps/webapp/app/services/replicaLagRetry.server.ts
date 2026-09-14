import { setTimeout as sleep } from "node:timers/promises";

export type ReplicaRetryOutcome = "replica_retry" | "primary" | "not_found";

// Replica-lag guard: on a miss, retry the replica once with jitter, then let the primary decide.
export async function findWithReplicaRetry<T>({
  replicaFind,
  primaryFind,
  hasDedicatedReplica,
  retryDelayMs,
  onOutcome,
}: {
  replicaFind: () => Promise<T | null>;
  primaryFind: () => Promise<T | null>;
  hasDedicatedReplica: boolean;
  retryDelayMs: { min: number; max: number };
  onOutcome?: (outcome: ReplicaRetryOutcome) => void;
}): Promise<T | null> {
  const report = (outcome: ReplicaRetryOutcome) => {
    try {
      onOutcome?.(outcome);
    } catch {}
  };

  const found = await replicaFind();
  if (found) {
    return found;
  }

  // Without a dedicated replica both lookups hit the same database, so a retry can't help.
  if (!hasDedicatedReplica) {
    report("not_found");
    return null;
  }

  await sleep(retryDelayMs.min + Math.random() * Math.max(0, retryDelayMs.max - retryDelayMs.min));

  const retried = await replicaFind();
  if (retried) {
    report("replica_retry");
    return retried;
  }

  const fromPrimary = await primaryFind();
  report(fromPrimary ? "primary" : "not_found");
  return fromPrimary;
}
