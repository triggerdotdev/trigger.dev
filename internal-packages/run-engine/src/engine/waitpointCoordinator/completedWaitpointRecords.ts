import type { CompletedWaitpointRecord, CompletedWaitpointRecordOutput } from "@internal/run-store";
import type { CompletionEnvelopeSource } from "./types.js";

/**
 * Turn sourced envelope fields into the frozen record set that rides one wait cycle's key.
 *
 * One record per DISTINCT id. The cycle's ordered id list carries multiplicity, and the
 * resolver expands one record into one entry per position of its id. That list holds only
 * batch-indexed ids, because its positions ARE the indexes, so this set — not the list — is
 * authoritative for membership.
 */
export function buildCompletedWaitpointRecords(
  sources: CompletionEnvelopeSource[]
): CompletedWaitpointRecord[] {
  const byId = new Map<string, CompletedWaitpointRecord>();

  for (const source of sources) {
    if (byId.has(source.id)) {
      continue;
    }

    byId.set(source.id, {
      id: source.id,
      friendlyId: source.friendlyId,
      type: source.type,
      completedAt: source.completedAt.toISOString(),
      outputType: source.outputType,
      outputIsError: source.outputIsError,
      output: chooseOutput(source),
      ...(source.completedByTaskRunId && { completedByTaskRunId: source.completedByTaskRunId }),
      ...(source.completedByBatchId && { completedByBatchId: source.completedByBatchId }),
      ...(source.completedAfter && { completedAfter: source.completedAfter.toISOString() }),
      ...(source.idempotencyKey && { idempotencyKey: source.idempotencyKey }),
    });
  }

  return [...byId.values()];
}

function chooseOutput(source: CompletionEnvelopeSource): CompletedWaitpointRecordOutput {
  // Ref BEFORE the RUN branch, which is the opposite order to the reference implementation in
  // completedWaitpointFreeze.test.ts. Both are byte-identical at read time, by that reference's
  // own reasoning: an offloaded RUN success has the same ref string in TaskRun.output. This
  // order is preferred because it needs no Postgres read to recover a string already in hand,
  // and because a deriveFromRun record whose run row is later deleted now refuses rather than
  // resolving empty — so routing an offloaded RUN success down the ref branch keeps it
  // resolvable when that row is gone.
  if (source.outputRef !== undefined) {
    return { ref: source.outputRef };
  }

  // A plain RUN output is re-readable from TaskRun.output verbatim. Three RUN cases are not.
  // An ERROR, because TaskRun.error is jsonb and does not round-trip to the same string. An
  // ORPHAN, because the back-reference is onDelete: SetNull so the completing row may be gone.
  // And an ABSENT output, which is the case that has to be checked here rather than left to the
  // read: a task that returns nothing completes its waitpoint with no output at all, and there
  // is then nothing to derive. Marking it derivable makes the resolver read a null TaskRun.output
  // and refuse the resume as a lost output, where the hydration this replaces resumes cleanly
  // with no output (`output: w.output ?? undefined`). A waitpoint that DID carry an output whose
  // run row has since gone still refuses, which is what the refusal is for.
  if (
    source.type === "RUN" &&
    !source.outputIsError &&
    source.output !== undefined &&
    source.completedByTaskRunId
  ) {
    return { deriveFromRun: true };
  }

  // Deliberately dropped, and this is the one place the record set does NOT reproduce the row.
  // A BATCH waitpoint IS completed with an output (see batchSystem), but the executor ignores
  // it: sharedRuntimeManager.resolveWaitpoint early-returns for type === "BATCH" and never
  // reads the body. Carrying it would put bytes in the cycle key that nothing can observe.
  if (source.type === "BATCH") {
    return null;
  }

  // An empty string is a value, not an absence, so this checks undefined only.
  return source.output === undefined ? null : { inline: source.output };
}
