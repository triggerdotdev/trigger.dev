import type { RedisOptions } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";

export type SnapshotKeys = { e: string; idx: string; cur: string; seq: string };

// All four core keys plus every snap:{runId}:wp:<n> key share the {runId} hash tag, so a run's whole
// state sits in one cluster slot and every mutation is one atomic script.
export function snapshotKeys(runId: string): SnapshotKeys {
  const base = `snap:{${runId}}`;
  return { e: `${base}:e`, idx: `${base}:idx`, cur: `${base}:cur`, seq: `${base}:seq` };
}

export type CompletedWaitpointRef = { id: string; index?: number };

// Reproduces PostgresRunStore.#createExecutionSnapshot's completedWaitpointOrder derivation exactly:
// drop anything without an index, sort ascending by index, map to id. Repeats are preserved, because
// the same run can sit in one batch more than once under a single idempotency key.
export function deriveOrder(completedWaitpoints: CompletedWaitpointRef[]): string[] {
  return completedWaitpoints
    .filter((w) => w.index !== undefined)
    .sort((a, b) => a.index! - b.index!)
    .map((w) => w.id);
}

// isValid is derived, never stored, so the entry JSON stays byte-identical to the caller's document.
export function isValidFor(entry: { error?: unknown }): boolean {
  return !entry.error;
}

export type SnapshotEntryInput = {
  id: string;
  engine: "V2";
  executionStatus: string;
  description: string;
  runId: string;
  runStatus: string;
  createdAt: string;
  attemptNumber?: number | null;
  previousSnapshotId?: string;
  batchId?: string;
  environmentId: string;
  environmentType: string;
  projectId: string;
  organizationId: string;
  checkpointId?: string;
  workerId?: string;
  runnerId?: string;
  metadata?: unknown;
  error?: string;
};

export type WaitpointIds = { present: boolean; distinctIds: string[]; order: string[] };

export type SnapshotRead = {
  id: string;
  seq: number;
  isValid: boolean;
  entry: Record<string, unknown>;
  raw: string;
  cycle?: { cycleSeq: number; count: number };
  completedWaitpointIds?: WaitpointIds;
};

export type AppendResult =
  | {
      outcome: "written";
      seq: number;
      cycleSeq?: number;
      ttl: "none" | "completion" | "reapplied";
      cycleMismatch: boolean;
    }
  | { outcome: "skippedNoKeyspace" }
  | { outcome: "forked"; actualCur: string };

export type SnapshotStoreMetrics = {
  recordAppend(outcome: string, ttl: string): void;
  recordEntryBytes(bytes: number): void;
  recordCycleKeyBytes(bytes: number): void;
  recordCycleCount(count: number): void;
  recordSkippedNoKeyspace(): void;
  recordCycleMismatch(): void;
  recordLatency(op: string, ms: number): void;
};

export type RedisSnapshotStoreOptions = {
  redisOptions: RedisOptions;
  completedTtlMs: number;
  sinceLimit?: number;
  highWater?: { entryBytes?: number; cycleKeyBytes?: number; cycleCount?: number };
  metrics?: SnapshotStoreMetrics;
  logger?: Logger;
};
