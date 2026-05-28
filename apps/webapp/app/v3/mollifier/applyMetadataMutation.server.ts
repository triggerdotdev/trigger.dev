import { applyMetadataOperations } from "@trigger.dev/core/v3";
import type { FlushedRunMetadata } from "@trigger.dev/core/v3/schemas";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

export type ApplyMetadataMutationOutcome =
  | { kind: "applied"; newMetadata: Record<string, unknown> }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "version_exhausted" };

// Apply a metadata PUT (body.metadata replace AND/OR body.operations
// deltas) to a buffered run's snapshot. Mirrors the PG-side
// `UpdateMetadataService.#updateRunMetadataWithOperations` retry loop:
// read snapshot → apply operations in JS → CAS-write back with the
// observed `metadataVersion`. Retries on conflict; bounded by
// `maxRetries`. The Lua CAS is the atomicity primitive — concurrent
// callers never lose an increment / append / set.
export async function applyMetadataMutationToBufferedRun(input: {
  runId: string;
  // Env+org scoping closes a cross-environment write gap on the buffer
  // path: the route's PG path is already env-scoped via Prisma filters,
  // and this helper now enforces the same isolation before any buffer
  // write so a caller authed in env A can't mutate a buffered run that
  // belongs to env B.
  environmentId: string;
  organizationId: string;
  body: Pick<FlushedRunMetadata, "metadata" | "operations">;
  buffer?: MollifierBuffer | null;
  maxRetries?: number;
}): Promise<ApplyMetadataMutationOutcome> {
  const buffer = input.buffer ?? getMollifierBuffer();
  if (!buffer) return { kind: "not_found" };

  // Default retry budget tuned for buffered-window concurrency. The
  // PG-side `UpdateMetadataService` uses 3, which is fine when the only
  // writer is the executing task itself. For a buffered run the writers
  // are external API callers, and N parallel writers exhaust 3 retries
  // quickly under contention. Bumping to 12 covers ~50-way concurrency
  // with sub-percent failure probability; the cost is bounded (each
  // retry is one Redis Lua call ~1ms).
  const maxRetries = input.maxRetries ?? 12;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const entry = await buffer.getEntry(input.runId);
    if (!entry) return { kind: "not_found" };
    // Env+org check: an entry from a different env is treated as a
    // miss (not 403) so existence in other envs doesn't leak.
    if (
      entry.envId !== input.environmentId ||
      entry.orgId !== input.organizationId
    ) {
      return { kind: "not_found" };
    }
    if (entry.status !== "QUEUED" || entry.materialised) {
      return { kind: "busy" };
    }

    const snapshot = JSON.parse(entry.payload) as Record<string, unknown>;
    const currentMetadataType =
      typeof snapshot.metadataType === "string" ? snapshot.metadataType : "application/json";

    // Starting point: either the body's replace metadata, or whatever's
    // already on the snapshot. PG-side service uses the same precedence
    // (replace overrides existing, operations apply on top).
    let metadataObject: Record<string, unknown>;
    if (input.body.metadata !== undefined) {
      metadataObject = input.body.metadata as Record<string, unknown>;
    } else if (typeof snapshot.metadata === "string") {
      try {
        metadataObject = JSON.parse(snapshot.metadata) as Record<string, unknown>;
      } catch {
        metadataObject = {};
      }
    } else {
      metadataObject = {};
    }

    if (input.body.operations?.length) {
      const result = applyMetadataOperations(metadataObject, input.body.operations);
      metadataObject = result.newMetadata;
    }

    const newMetadataStr = JSON.stringify(metadataObject);
    const cas = await buffer.casSetMetadata({
      runId: input.runId,
      expectedVersion: entry.metadataVersion,
      newMetadata: newMetadataStr,
      newMetadataType: currentMetadataType,
    });

    if (cas.kind === "applied") {
      return { kind: "applied", newMetadata: metadataObject };
    }
    if (cas.kind === "not_found") return { kind: "not_found" };
    if (cas.kind === "busy") return { kind: "busy" };
    // version_conflict — another caller wrote between our read + CAS.
    // Small jittered backoff so a thundering herd of N retriers doesn't
    // all re-read + re-CAS at exactly the same moment.
    logger.debug("applyMetadataMutationToBufferedRun: version_conflict, retrying", {
      runId: input.runId,
      attempt,
      observedVersion: entry.metadataVersion,
      currentVersion: cas.currentVersion,
    });
    const backoffMs = Math.floor(Math.random() * (5 + attempt * 5));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  logger.warn("applyMetadataMutationToBufferedRun: retries exhausted", {
    runId: input.runId,
    maxRetries,
  });
  return { kind: "version_exhausted" };
}
