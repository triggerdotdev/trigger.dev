// Builds the Redis entry for each execution-snapshot write site, from that site's own INPUT.
//
// Not from the delegate's return value: no nested write site includes the snapshot in what it
// returns. `createRun` returns the run, `expireParkedRun` returns a count, and the rest return a
// selected `TaskRun`. That means every value Postgres derives rather than receives has to be
// reproduced here, and snapshotEntry.parity.test.ts is what keeps the two sides from drifting.
import type { TaskRunStatus } from "@trigger.dev/database";
import type { SnapshotEntryInput } from "./redisSnapshotStore.js";
import type {
  CompletionSnapshotInput,
  CreateExecutionSnapshotInput,
  CreateRunSnapshotInput,
  ExpireSnapshotInput,
  LockSnapshotInput,
  RescheduleSnapshotInput,
} from "./types.js";

export type EntryBuildContext = { id: string; runId: string; createdAt: Date };

/**
 * PostgresRunStore.#createExecutionSnapshot rewrites DEQUEUED to PENDING, because older runners
 * reject DEQUEUED on a snapshot. Every site that can carry that status must rewrite it identically.
 */
function snapshotRunStatus(status: TaskRunStatus): string {
  return status === "DEQUEUED" ? "PENDING" : status;
}

function base(ctx: EntryBuildContext) {
  return {
    id: ctx.id,
    runId: ctx.runId,
    createdAt: ctx.createdAt.toISOString(),
    engine: "V2" as const,
  };
}

export function entryFromCreateRun(
  ctx: EntryBuildContext,
  snapshot: CreateRunSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: snapshot.executionStatus,
    description: snapshot.description,
    runStatus: snapshotRunStatus(snapshot.runStatus),
    environmentId: snapshot.environmentId,
    environmentType: snapshot.environmentType,
    projectId: snapshot.projectId,
    organizationId: snapshot.organizationId,
    ...(snapshot.workerId !== undefined && { workerId: snapshot.workerId }),
    ...(snapshot.runnerId !== undefined && { runnerId: snapshot.runnerId }),
  };
}

/**
 * `completeAttemptSuccess` writes no `engine` column, so Postgres applies the schema default of
 * `V2`. The entry states it, because SnapshotEntryInput requires the field.
 */
export function entryFromCompletion(
  ctx: EntryBuildContext,
  snapshot: CompletionSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: snapshot.executionStatus,
    description: snapshot.description,
    runStatus: snapshotRunStatus(snapshot.runStatus),
    attemptNumber: snapshot.attemptNumber,
    environmentId: snapshot.environmentId,
    environmentType: snapshot.environmentType,
    projectId: snapshot.projectId,
    organizationId: snapshot.organizationId,
    ...(snapshot.workerId !== undefined && { workerId: snapshot.workerId }),
    ...(snapshot.runnerId !== undefined && { runnerId: snapshot.runnerId }),
  };
}

/** Serves both `expireRun` and `expireParkedRun`; the two write identical snapshot columns. */
export function entryFromExpire(
  ctx: EntryBuildContext,
  snapshot: ExpireSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: snapshot.executionStatus,
    description: snapshot.description,
    runStatus: snapshotRunStatus(snapshot.runStatus),
    environmentId: snapshot.environmentId,
    environmentType: snapshot.environmentType,
    projectId: snapshot.projectId,
    organizationId: snapshot.organizationId,
  };
}

/** PostgresRunStore.rescheduleRun supplies these three defaults inline, so the entry repeats them. */
export function entryFromReschedule(
  ctx: EntryBuildContext,
  snapshot: RescheduleSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: snapshot.executionStatus ?? "DELAYED",
    description: snapshot.description ?? "Delayed run was rescheduled to a future date",
    runStatus: snapshotRunStatus(snapshot.runStatus ?? "DELAYED"),
    environmentId: snapshot.environmentId,
    environmentType: snapshot.environmentType,
    projectId: snapshot.projectId,
    organizationId: snapshot.organizationId,
  };
}

/** PostgresRunStore.#lockRunToWorker hard-codes the status, description and run status. */
export function entryFromLock(
  ctx: EntryBuildContext,
  snapshot: LockSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: "PENDING_EXECUTING",
    description: "Run was dequeued for execution",
    runStatus: "PENDING",
    previousSnapshotId: snapshot.previousSnapshotId,
    ...(snapshot.attemptNumber !== undefined && { attemptNumber: snapshot.attemptNumber }),
    ...(snapshot.batchId !== undefined && { batchId: snapshot.batchId }),
    ...(snapshot.checkpointId !== undefined && { checkpointId: snapshot.checkpointId }),
    environmentId: snapshot.environmentId,
    environmentType: snapshot.environmentType,
    projectId: snapshot.projectId,
    organizationId: snapshot.organizationId,
    ...(snapshot.workerId !== undefined && { workerId: snapshot.workerId }),
    ...(snapshot.runnerId !== undefined && { runnerId: snapshot.runnerId }),
  };
}

export function entryFromCreateExecutionSnapshot(
  ctx: EntryBuildContext,
  input: CreateExecutionSnapshotInput
): SnapshotEntryInput {
  return {
    ...base(ctx),
    executionStatus: input.snapshot.executionStatus,
    description: input.snapshot.description,
    runStatus: snapshotRunStatus(input.run.status),
    ...(input.run.attemptNumber !== undefined &&
      input.run.attemptNumber !== null && { attemptNumber: input.run.attemptNumber }),
    ...(input.previousSnapshotId !== undefined && { previousSnapshotId: input.previousSnapshotId }),
    ...(input.batchId !== undefined && { batchId: input.batchId }),
    environmentId: input.environmentId,
    environmentType: input.environmentType,
    projectId: input.projectId,
    organizationId: input.organizationId,
    ...(input.checkpointId !== undefined && { checkpointId: input.checkpointId }),
    ...(input.workerId !== undefined && { workerId: input.workerId }),
    ...(input.runnerId !== undefined && { runnerId: input.runnerId }),
    ...(input.snapshot.metadata !== undefined &&
      input.snapshot.metadata !== null && { metadata: input.snapshot.metadata }),
    ...(input.error !== undefined && { error: input.error }),
  };
}

/**
 * A terminal entry is what makes the append script apply the completion TTL. FINISHED is the only
 * terminal execution status; the run-level status is not consulted, because a run reaches its
 * terminal state through a FINISHED snapshot in every path.
 */
export function isTerminalEntry(entry: SnapshotEntryInput): boolean {
  return entry.executionStatus === "FINISHED";
}

/**
 * Builds an entry from a snapshot ROW rather than a write site's input, which only the repair path
 * needs: it re-appends a snapshot Postgres already holds, so every derived value is read back rather
 * than reproduced. A null column is omitted, not carried as null, so the document matches what the
 * lost append would have written.
 */
export function entryFromSnapshotRow(row: SnapshotRowForEntry): SnapshotEntryInput {
  return {
    id: row.id,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    engine: "V2",
    executionStatus: row.executionStatus,
    description: row.description,
    runStatus: snapshotRunStatus(row.runStatus),
    ...(row.attemptNumber !== null && { attemptNumber: row.attemptNumber }),
    ...(row.previousSnapshotId !== null && { previousSnapshotId: row.previousSnapshotId }),
    ...(row.batchId !== null && { batchId: row.batchId }),
    environmentId: row.environmentId,
    environmentType: row.environmentType,
    projectId: row.projectId,
    organizationId: row.organizationId,
    ...(row.checkpointId !== null && { checkpointId: row.checkpointId }),
    ...(row.workerId !== null && { workerId: row.workerId }),
    ...(row.runnerId !== null && { runnerId: row.runnerId }),
    ...(row.metadata !== null && { metadata: row.metadata }),
    ...(row.error !== null && { error: row.error }),
  };
}

export type SnapshotRowForEntry = {
  id: string;
  runId: string;
  createdAt: Date;
  executionStatus: string;
  description: string;
  runStatus: TaskRunStatus;
  attemptNumber: number | null;
  previousSnapshotId: string | null;
  batchId: string | null;
  environmentId: string;
  environmentType: string;
  projectId: string;
  organizationId: string;
  checkpointId: string | null;
  workerId: string | null;
  runnerId: string | null;
  metadata: unknown;
  error: string | null;
};
