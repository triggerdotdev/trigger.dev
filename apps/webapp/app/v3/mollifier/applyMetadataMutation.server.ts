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
  body: Pick<FlushedRunMetadata, "metadata" | "operations">;
  buffer?: MollifierBuffer | null;
  maxRetries?: number;
}): Promise<ApplyMetadataMutationOutcome> {
  const buffer = input.buffer ?? getMollifierBuffer();
  if (!buffer) return { kind: "not_found" };

  const maxRetries = input.maxRetries ?? 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const entry = await buffer.getEntry(input.runId);
    if (!entry) return { kind: "not_found" };
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
    // Loop to re-read and retry.
    logger.debug("applyMetadataMutationToBufferedRun: version_conflict, retrying", {
      runId: input.runId,
      attempt,
      observedVersion: entry.metadataVersion,
      currentVersion: cas.currentVersion,
    });
  }

  logger.warn("applyMetadataMutationToBufferedRun: retries exhausted", {
    runId: input.runId,
    maxRetries,
  });
  return { kind: "version_exhausted" };
}
