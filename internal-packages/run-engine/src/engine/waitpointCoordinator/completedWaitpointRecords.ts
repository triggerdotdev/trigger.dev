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
  if (source.outputRef !== undefined) {
    return { ref: source.outputRef };
  }

  // A plain RUN output is re-readable from TaskRun.output verbatim. Two RUN cases are not,
  // and both must stay inline: an ERROR, because TaskRun.error is jsonb and does not
  // round-trip to the same string, and an ORPHAN, because the back-reference is
  // onDelete: SetNull so the completing row may be gone.
  if (source.type === "RUN" && !source.outputIsError && source.completedByTaskRunId) {
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
