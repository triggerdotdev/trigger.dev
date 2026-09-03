import type {
  CompletedWaitpointRecord,
  ResolveCompletedWaitpointsArgs,
  RunStore,
} from "@internal/run-store";
import { BatchId, RunId } from "@trigger.dev/core/v3/isomorphic";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3/schemas";

/**
 * A waitpoint id that no half of a snapshot can account for, or that both halves claim.
 *
 * This exists because the id classifier is total and never throws: an unrecognised shape
 * classifies as legacy, finds no row, and would otherwise disappear from the resumed run's
 * completed set with no error at all.
 */
export type UnresolvableReason = "no-source" | "two-sources" | "lost-run-output";

const MESSAGES: Record<UnresolvableReason, (id: string) => string> = {
  "no-source": (id) =>
    `Waitpoint ${id} has neither a cycle record nor a fetched row. Refusing to resume without it.`,
  "two-sources": (id) =>
    `Waitpoint ${id} resolved twice, from a cycle record and from a fetched row.`,
  "lost-run-output": (id) =>
    `Waitpoint ${id} defers its output to its completing run, and that run's output is gone. Refusing to resume with an empty output.`,
};

export class UnresolvableWaitpointId extends Error {
  readonly waitpointId: string;
  readonly reason: UnresolvableReason;

  constructor(waitpointId: string, reason: UnresolvableReason) {
    super(MESSAGES[reason](waitpointId));
    this.name = "UnresolvableWaitpointId";
    this.waitpointId = waitpointId;
    this.reason = reason;
  }
}

export type CompletedWaitpointResolverDeps = {
  /**
   * Reads TaskRun.output for a SET of completing runs, keyed by run id.
   *
   * Plural on purpose. A batch parent resumes on every child at once, so a per-id reader made
   * the resolver do one round trip per child -- 500 of them, in series, for a 500-wide fan-in,
   * where the path this replaces did one chunked read. An id absent from the returned map is an
   * absent output, which the caller refuses rather than resolving empty.
   *
   * Optional, because most cycles carry no `deriveFromRun` record and therefore never need it.
   * A cycle that DOES carry one without a reader is a wiring error, not a data condition, so it
   * throws rather than resolving empty.
   */
  readRunOutputs?(taskRunIds: string[]): Promise<Map<string, string>>;
};

// Bounds one read, for the reason the envelope and waitpoint reads share: a run output can be
// 100KB+, so a wide fan-in read whole can exceed Node's string conversion limits.
const RUN_OUTPUT_CHUNK_SIZE = 100;

/**
 * The production reader: TaskRun.output for the completing runs, through the store so each read
 * routes to the run's owning database.
 *
 * `findRunsByIds` is the store's own grouped replacement for `Promise.all(ids.map(findRun))`,
 * and it forces `id` into the projection so the map keys correctly even though this select
 * names only `output`.
 *
 * Takes no read client on purpose. The router reads the owning store's REPLICA when no client is
 * passed, and forces its PRIMARY for any client that is not replica-branded -- so accepting one
 * would let a caller put a wide `TaskRun.output` read on the writer by reflex. This read does not
 * need read-your-writes: the child run committed its output before it completed the waitpoint that
 * unblocked this parent, so replica lag cannot hide it. That is the opposite of the envelope read
 * in the legacy arm, which reads a waitpoint completed moments earlier and must use the writer.
 */
export function createRunOutputsReader(
  runStore: Pick<RunStore, "findRunsByIds">
): (taskRunIds: string[]) => Promise<Map<string, string>> {
  return async (taskRunIds) => {
    const outputs = new Map<string, string>();

    for (let i = 0; i < taskRunIds.length; i += RUN_OUTPUT_CHUNK_SIZE) {
      const chunk = taskRunIds.slice(i, i + RUN_OUTPUT_CHUNK_SIZE);
      const rows = await runStore.findRunsByIds(chunk, { select: { output: true } });

      for (const [id, row] of rows) {
        // A row present with a null output is the same absence as a missing row: either way the
        // value the waitpoint deferred is gone. Omitting it here keeps one absence rule, so the
        // caller's refusal covers both.
        if (row.output !== null) {
          outputs.set(id, row.output);
        }
      }
    }

    return outputs;
  };
}

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

    // Over the WHOLE membership, not `order`. The order omits every index-less wait, so a
    // check scoped to it cannot see an index-less id whose record is missing — which is the
    // exact loss this resolver exists to make impossible.
    for (const id of new Set([...args.distinctIds, ...args.order])) {
      if (!recordIds.has(id) && !resolvedElsewhere.has(id)) {
        throw new UnresolvableWaitpointId(id, "no-source");
      }
    }

    // Every deferred output in ONE read, before the emit loop. Reading inside the loop meant a
    // round trip per record, in series, which is the shape a batch fan-in punishes hardest: the
    // wide wait this feature exists to make cheap is exactly the wide wait that paid most.
    const runOutputs = await readDeferredOutputs(args.records, deps);

    // Positions once, not once per record. `positionsOf` scanned the whole order for every
    // record, so the emit loop was O(records x order) -- a million comparisons for a 1000-wide
    // wait, growing with the same input as above.
    const positions = positionsById(args.order);

    const out: CompletedWaitpoint[] = [];

    for (const record of args.records) {
      const indexes = positions.get(record.id) ?? [undefined];
      // Hydrated once per record, not once per position, so a run at several batch indexes
      // resolves from one map entry rather than one per index.
      const output = hydrateOutput(record, runOutputs);

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

// Every id's positions in the order, built in one pass.
//
// An id ABSENT from this map has no position, and the caller emits it once with an undefined
// index -- matching what the existing hydration does for a wait that carried no batch index.
// Absence is how that case is carried, so this never stores an [undefined] entry itself.
function positionsById(order: string[]): Map<string, number[]> {
  const positions = new Map<string, number[]>();

  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (id === undefined) {
      continue;
    }

    const existing = positions.get(id);
    if (existing) {
      existing.push(i);
    } else {
      positions.set(id, [i]);
    }
  }

  return positions;
}

/**
 * The output of every run a record defers to, in one batched read.
 *
 * Returns an empty map when no record defers, which is the common case: a cycle carrying only
 * inline values, refs and BATCH records reads nothing at all.
 */
async function readDeferredOutputs(
  records: CompletedWaitpointRecord[],
  deps: CompletedWaitpointResolverDeps
): Promise<Map<string, string>> {
  const runIds = new Set<string>();
  let read: NonNullable<CompletedWaitpointResolverDeps["readRunOutputs"]> | undefined;

  for (const record of records) {
    const runId = deferredRunIdOf(record);
    if (runId === undefined) {
      continue;
    }

    // Checked here rather than after the pass, so the message names a record that really does
    // defer rather than whichever one happened to be first. A missing reader is a wiring fault,
    // so every deferring record is equally implicated and the first is as informative as any.
    if (!deps.readRunOutputs) {
      throw new Error(
        `Waitpoint ${record.id} defers its output to run ${runId}, but the resolver was built with no run-output reader.`
      );
    }

    read = deps.readRunOutputs;
    runIds.add(runId);
  }

  // Set exactly when a record deferred, so this is the same condition as an empty `runIds` --
  // and unlike `runIds.size`, it carries the reader with it.
  if (read === undefined) {
    return new Map();
  }

  return read([...runIds]);
}

// The run a record defers its output to, or undefined when it carries its own output or has
// nothing to defer to. This is the single definition of "needs a run read", so the pre-pass and
// the hydration cannot disagree about which records those are.
function deferredRunIdOf(record: CompletedWaitpointRecord): string | undefined {
  if (record.output === null) {
    return undefined;
  }

  if ("inline" in record.output || "ref" in record.output) {
    return undefined;
  }

  return record.completedByTaskRunId ?? undefined;
}

// Synchronous: every read this needs already happened in readDeferredOutputs.
function hydrateOutput(
  record: CompletedWaitpointRecord,
  runOutputs: Map<string, string>
): string | undefined {
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

  const runId = deferredRunIdOf(record);
  if (runId === undefined) {
    return undefined;
  }

  // Postgres does not lose this: the back-reference nulls on delete but Waitpoint.output stays,
  // so the legacy path still emits it. Returning undefined here instead would resolve the
  // parent's triggerAndWait successfully with no output, which is silent wrong data.
  const output = runOutputs.get(runId);
  if (output === undefined) {
    throw new UnresolvableWaitpointId(record.id, "lost-run-output");
  }

  return output;
}
