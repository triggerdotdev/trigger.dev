import type { Waitpoint } from "@trigger.dev/database";
import type { CompletionEnvelopeSource } from "./types.js";

/**
 * Map a waitpoint row onto the arm-independent envelope source.
 *
 * Shared so the legacy arm and the equivalence suite cannot drift: if the suite hand-rolled its
 * own copy, a bug in the arm would be invisible to every test that compares against the oracle.
 */
export function envelopeSourceFromWaitpointRow(
  row: Pick<
    Waitpoint,
    | "id"
    | "friendlyId"
    | "type"
    | "completedAt"
    | "output"
    | "outputType"
    | "outputIsError"
    | "completedByTaskRunId"
    | "completedByBatchId"
    | "completedAfter"
    | "idempotencyKey"
    | "userProvidedIdempotencyKey"
    | "inactiveIdempotencyKey"
  >
): CompletionEnvelopeSource {
  // An already-offloaded value is named by its type, not by its shape, so the type is what
  // decides whether the string is a payload or a reference to one.
  const isRef = row.outputType === "application/store";

  return {
    id: row.id,
    friendlyId: row.friendlyId,
    type: row.type,
    // A completed waitpoint always has this. The fallback keeps the shape total rather than
    // emitting an invalid Date, and mirrors the fallback the snapshot hydration already applies.
    completedAt: row.completedAt ?? new Date(),
    outputType: row.outputType,
    outputIsError: row.outputIsError,
    ...(row.output !== null && row.output !== undefined
      ? isRef
        ? { outputRef: row.output }
        : { output: row.output }
      : {}),
    ...(row.completedByTaskRunId && { completedByTaskRunId: row.completedByTaskRunId }),
    ...(row.completedByBatchId && { completedByBatchId: row.completedByBatchId }),
    ...(row.completedAfter && { completedAfter: row.completedAfter }),
    ...(row.userProvidedIdempotencyKey && !row.inactiveIdempotencyKey && row.idempotencyKey
      ? { idempotencyKey: row.idempotencyKey }
      : {}),
  };
}
