import type { CompletedWaitpointRecord, ResolveCompletedWaitpointsArgs } from "@internal/run-store";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3/schemas";

/**
 * A waitpoint id that no half of a snapshot can account for, or that both halves claim.
 *
 * This exists because the id classifier is total and never throws: an unrecognised shape
 * classifies as legacy, finds no row, and would otherwise disappear from the resumed run's
 * completed set with no error at all.
 */
export class UnresolvableWaitpointId extends Error {
  readonly waitpointId: string;
  readonly reason: "no-source" | "two-sources";

  constructor(waitpointId: string, reason: "no-source" | "two-sources") {
    super(
      reason === "no-source"
        ? `Waitpoint ${waitpointId} has neither a cycle record nor a fetched row. Refusing to resume without it.`
        : `Waitpoint ${waitpointId} resolved twice, from a cycle record and from a fetched row.`
    );
    this.name = "UnresolvableWaitpointId";
    this.waitpointId = waitpointId;
    this.reason = reason;
  }
}

export type CompletedWaitpointResolverDeps = {
  /** Reads TaskRun.output. Returns undefined when the row is gone. */
  readRunOutput(taskRunId: string): Promise<string | undefined>;
};

export type ResolveArgs = ResolveCompletedWaitpointsArgs & {
  /** Ids the caller resolved from Postgres rows. Read by the coverage check only. */
  resolvedElsewhere?: string[];
};

/**
 * Rebuild `CompletedWaitpoint[]` from one wait cycle's records.
 *
 * Field-for-field equivalent to `enhanceExecutionSnapshotWithWaitpoints`, which is what the
 * executor already consumes. It iterates the RECORDS, not the order: the order holds only
 * batch-indexed ids, so iterating it would silently drop every index-less wait.
 *
 * Returns the store-resident half only. A mixed snapshot's legacy half arrives as Postgres
 * rows and is expanded by the existing path, and the caller concatenates. Both halves read
 * their index from the same order, so the positions agree with no coordination.
 */
export function createCompletedWaitpointResolver(deps: CompletedWaitpointResolverDeps) {
  return async function resolveCompletedWaitpoints(
    args: ResolveArgs
  ): Promise<CompletedWaitpoint[]> {
    const recordIds = new Set(args.records.map((record) => record.id));
    const resolvedElsewhere = new Set(args.resolvedElsewhere ?? []);

    for (const id of resolvedElsewhere) {
      if (recordIds.has(id)) {
        throw new UnresolvableWaitpointId(id, "two-sources");
      }
    }

    for (const id of args.order) {
      if (!recordIds.has(id) && !resolvedElsewhere.has(id)) {
        throw new UnresolvableWaitpointId(id, "no-source");
      }
    }

    const out: CompletedWaitpoint[] = [];

    for (const record of args.records) {
      const indexes = positionsOf(record.id, args.order);
      // Hydrated once per record, not once per position, so a run at several batch indexes
      // costs one read rather than one per index.
      const output = await hydrateOutput(record, deps);

      for (const index of indexes) {
        out.push({
          id: record.id,
          index,
          friendlyId: record.friendlyId,
          type: record.type,
          completedAt: new Date(record.completedAt),
          ...(record.idempotencyKey && { idempotencyKey: record.idempotencyKey }),
          ...(record.completedByTaskRunId && {
            completedByTaskRun: {
              id: record.completedByTaskRunId,
              friendlyId: RunId.toFriendlyId(record.completedByTaskRunId),
              // The reading entry's batch, never the entry that minted the cycle.
              ...(args.batchId && {
                batch: { id: args.batchId, friendlyId: BatchId.toFriendlyId(args.batchId) },
              }),
            },
          }),
          ...(record.completedAfter && { completedAfter: new Date(record.completedAfter) }),
          ...(record.completedByBatchId && {
            completedByBatch: {
              id: record.completedByBatchId,
              friendlyId: BatchId.toFriendlyId(record.completedByBatchId),
            },
          }),
          ...(output !== undefined && { output }),
          outputType: record.outputType,
          outputIsError: record.outputIsError,
        });
      }
    }

    return out;
  };
}

// An id with no position yields one entry with an undefined index, matching what the
// existing hydration does for a wait that carried no batch index.
function positionsOf(waitpointId: string, order: string[]): (number | undefined)[] {
  const indexes: (number | undefined)[] = [];

  for (let i = 0; i < order.length; i++) {
    if (order[i] === waitpointId) {
      indexes.push(i);
    }
  }

  return indexes.length === 0 ? [undefined] : indexes;
}

async function hydrateOutput(
  record: CompletedWaitpointRecord,
  deps: CompletedWaitpointResolverDeps
): Promise<string | undefined> {
  if (record.output === null) {
    return undefined;
  }

  if ("inline" in record.output) {
    return record.output.inline;
  }

  // A ref is handed back as the output verbatim: the executor already resolves an
  // application/store output the same way it does for a Postgres-served snapshot.
  if ("ref" in record.output) {
    return record.output.ref;
  }

  if (!record.completedByTaskRunId) {
    return undefined;
  }

  return deps.readRunOutput(record.completedByTaskRunId);
}
