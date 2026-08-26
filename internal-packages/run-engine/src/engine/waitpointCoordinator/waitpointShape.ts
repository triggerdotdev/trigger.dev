import type { Waitpoint } from "@trigger.dev/database";
import type {
  WaitpointCompletion,
  WaitpointRecordInput,
  WaitpointStatus,
} from "./storeCoordinator.js";

/**
 * Present a store-resident waitpoint as the Postgres row shape the seam returns.
 *
 * A store waitpoint has no row, but `WaitpointCoordinator`'s return types are the Prisma
 * `Waitpoint`, and callers reach for its columns directly. Every column is listed
 * explicitly rather than spread: a missing non-null column surfaces as `undefined` far
 * from here, in a consumer that had no reason to guard.
 */
export function toPrismaWaitpoint(
  record: WaitpointRecordInput,
  status: WaitpointStatus,
  completion?: WaitpointCompletion
): Waitpoint {
  if (!record.idempotencyKey) {
    // Non-null in the schema, and half of the (environmentId, idempotencyKey) unique
    // index, so a synthesized value could collide with a real one. Every arm mints one.
    throw new Error(`Waitpoint ${record.id} has no idempotency key`);
  }

  const output = completion?.output;

  return {
    id: record.id,
    friendlyId: record.friendlyId,
    type: record.type,
    status,
    completedAt: completion ? new Date(completion.completedAt) : null,
    idempotencyKey: record.idempotencyKey,
    userProvidedIdempotencyKey: record.userProvidedIdempotencyKey,
    idempotencyKeyExpiresAt: optionalDate(record.idempotencyKeyExpiresAt),
    // Not ported: clearing an idempotency key is a legacy debounce mechanism the store
    // replaces with key expiry.
    inactiveIdempotencyKey: null,
    completedByTaskRunId: record.completedByTaskRunId ?? null,
    completedAfter: optionalDate(record.completedAfter),
    completedByBatchId: record.completedByBatchId ?? null,
    // An offloaded reference rides the output column exactly as it does on a legacy row,
    // with outputType naming it. A null output is re-derived at read time, never copied.
    output: output ? ("inline" in output ? output.inline : output.ref) : null,
    outputType: completion?.outputType ?? "application/json",
    outputIsError: completion?.outputIsError ?? false,
    projectId: record.projectId,
    environmentId: record.environmentId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    tags: record.tags,
  };
}

function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}
