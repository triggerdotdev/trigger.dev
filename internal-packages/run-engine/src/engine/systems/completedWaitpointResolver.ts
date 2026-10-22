import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
// The production completed-waitpoint record builder + resolver. The reference implementation
// this mirrors, and the shape contract, live in completedWaitpointFreeze.test.ts.
import type { Waitpoint } from "@trigger.dev/database";
import type {
  CompletedWaitpointRecord,
  CompletedWaitpointRecordOutput,
  CompletedWaitpointResolver,
  ResolveCompletedWaitpointsArgs,
  RunStore,
  ReadClient,
  SnapshotReadWaitpoint,
} from "@internal/run-store";

/**
 * WRITE side. One Waitpoint row becomes one record, deduped to one per DISTINCT id: the
 * enhancement step re-expands each id at every position it holds in the cycle's order list, so a
 * repeated id must appear once here. First-seen order is preserved.
 */
export function buildCompletedWaitpointRecords(
  waitpoints: Waitpoint[]
): CompletedWaitpointRecord[] {
  const seen = new Set<string>();
  const records: CompletedWaitpointRecord[] = [];
  for (const w of waitpoints) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    records.push(toRecord(w));
  }
  return records;
}

function toRecord(w: Waitpoint): CompletedWaitpointRecord {
  return {
    id: w.id,
    friendlyId: w.friendlyId,
    type: w.type,
    completedAt: (w.completedAt ?? new Date()).toISOString(),
    outputType: w.outputType,
    outputIsError: w.outputIsError,
    output: recordOutputFor(w),
    completedByTaskRunId: w.completedByTaskRunId ?? undefined,
    completedByBatchId: w.completedByBatchId ?? undefined,
    completedAfter: w.completedAfter?.toISOString(),
    idempotencyKey:
      w.userProvidedIdempotencyKey && !w.inactiveIdempotencyKey ? w.idempotencyKey : undefined,
  };
}

function recordOutputFor(w: Waitpoint): CompletedWaitpointRecordOutput {
  if (w.output === null) return null;
  // A RUN success re-derives byte-identically from TaskRun.output, so it carries no copy.
  // A RUN error cannot (TaskRun.error is jsonb), so it carries inline. This branch is
  // deliberately BEFORE the application/store branch: an offloaded RUN success is still
  // deriveFromRun, because TaskRun.output holds the same ref string.
  if (w.type === "RUN" && !w.outputIsError && w.completedByTaskRunId)
    return { deriveFromRun: true };
  if (w.outputType === "application/store") return { ref: w.output };
  return { inline: w.output };
}

/**
 * READ side. One record becomes ONE unenhanced snapshot-read row — the same material a Postgres
 * waitpoint row carries — with the deriveFromRun TaskRun.output lookup injected as a synchronous
 * closure. Iterates `records`, never `order`.
 *
 * Deliberately does NOT expand repeated positions, assign `index`, or build the nested
 * `completedByTaskRun` / `completedByBatch` objects: `enhanceExecutionSnapshotWithWaitpoints` is the
 * single step that does all of that, for every backend. Doing any of it here is what previously made
 * a Redis-served read get enhanced twice, silently dropping the completion associations.
 */
export function expandCompletedWaitpointRecords(
  args: ResolveCompletedWaitpointsArgs,
  lookupRunOutput: (runId: string) => string | undefined
): SnapshotReadWaitpoint[] {
  const out: SnapshotReadWaitpoint[] = [];
  for (const record of args.records) {
    let output: string | undefined;
    if (record.output === null) {
      output = undefined;
    } else if ("inline" in record.output) {
      output = record.output.inline;
    } else if ("ref" in record.output) {
      output = record.output.ref;
    } else if ("deriveFromRun" in record.output) {
      output = record.completedByTaskRunId
        ? lookupRunOutput(record.completedByTaskRunId)
        : undefined;
    } else {
      const _never: never = record.output;
      throw new Error(`unknown record output variant: ${JSON.stringify(_never)}`);
    }

    out.push({
      id: record.id,
      friendlyId: record.friendlyId,
      type: record.type,
      completedAt: new Date(record.completedAt),
      completedByTaskRunId: record.completedByTaskRunId ?? null,
      completedByBatchId: record.completedByBatchId ?? null,
      completedAfter: record.completedAfter ? new Date(record.completedAfter) : null,
      output: output ?? null,
      outputType: record.outputType,
      outputIsError: record.outputIsError,
      // The record stores the ALREADY-RESOLVED user-visible key, so it is re-expressed as the triple
      // the enhancement step reads: a key present means user-provided and active, absent means the
      // step yields undefined — matching what it computes from a Postgres row.
      idempotencyKey: record.idempotencyKey ?? "",
      userProvidedIdempotencyKey: record.idempotencyKey !== undefined,
      inactiveIdempotencyKey: null,
    });
  }
  return out;
}

/**
 * The production resolver: the curried form the waitpoint lane binds to a run-store. It
 * collects the run ids of every deriveFromRun record, reads their TaskRun.output in ONE
 * `findRunsByIds` (which routes each run to its owning shard, so a waitpoint completed by a
 * run on another shard is resolved correctly), then expands synchronously.
 */
export function createCompletedWaitpointResolver(
  runStore: Pick<RunStore, "findRunsByIds">,
  client?: ReadClient,
  requireRunRows = false
): CompletedWaitpointResolver {
  return async (args) => {
    const runIds = new Set<string>();
    for (const record of args.records) {
      if (record.output && "deriveFromRun" in record.output && record.completedByTaskRunId) {
        runIds.add(record.completedByTaskRunId);
      }
    }

    const outputs = new Map<string, string | undefined>();
    if (runIds.size > 0) {
      const runs = await runStore.findRunsByIds([...runIds], { select: { output: true } }, client);
      for (const id of runIds) {
        if (requireRunRows && !runs.has(id))
          throw new Error(`No completing TaskRun ${id} for shared waitpoint result`);
        outputs.set(id, runs.get(id)?.output ?? undefined);
      }
    }

    return expandCompletedWaitpointRecords(args, (id) => outputs.get(id));
  };
}

/**
 * Redis-primary cycles can mix old Postgres tokens with MemoryDB tokens. Only a MemoryDB RUN
 * completion proves that its child output has committed independently of the snapshot replica.
 * Resolve those children on their owning primary and fail closed on missing rows; retain the
 * established read policy for every legacy record, including deployments using TRES alone.
 */
export function createStoreRunCompletedWaitpointResolver(
  runStore: Pick<RunStore, "findRunsByIds">,
  primaryReadClient: ReadClient,
  isEnabled?: (organizationId: string) => boolean | Promise<boolean>
): (
  args: ResolveCompletedWaitpointsArgs,
  context?: { organizationId: string }
) => ReturnType<CompletedWaitpointResolver> {
  const legacy = createCompletedWaitpointResolver(runStore);
  const store = createCompletedWaitpointResolver(runStore, primaryReadClient, true);
  return async (args, context) => {
    // TRES alone retains the original resolver without partitioning or parsing completion IDs.
    if (!context?.organizationId || (await isEnabled?.(context.organizationId)) !== true) {
      return legacy(args);
    }
    const storeRecords: CompletedWaitpointRecord[] = [];
    const legacyRecords: CompletedWaitpointRecord[] = [];
    for (const record of args.records) {
      (record.type === "RUN" &&
      parseWaitpointId(record.id).format !== "legacy" &&
      record.output &&
      "deriveFromRun" in record.output
        ? storeRecords
        : legacyRecords
      ).push(record);
    }
    if (storeRecords.length === 0) return legacy(args);
    if (legacyRecords.length === 0) return store(args);
    const [legacyRows, storeRows] = await Promise.all([
      legacy({ ...args, records: legacyRecords }),
      store({ ...args, records: storeRecords }),
    ]);
    const rows = new Map([...legacyRows, ...storeRows].map((row) => [row.id, row]));
    return args.records.map((record) => rows.get(record.id)!);
  };
}
