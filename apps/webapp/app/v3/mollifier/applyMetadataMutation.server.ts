import { applyMetadataOperations } from "@trigger.dev/core/v3";
import type { FlushedRunMetadata } from "@trigger.dev/core/v3/schemas";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import { getMollifierBuffer } from "./mollifierBuffer.server";

// On `applied` we surface the parent/root friendlyIds captured during
// the snapshot read. Callers that fan parent/root metadata operations
// out to their respective runs can use these without a second
// `findRunByIdWithMollifierFallback` round trip — and, more importantly,
// without racing the drainer's terminal-failure path (which atomically
// DELetes the entry hash). Without these on the outcome the second
// read can come back null mid-route, silently dropping the caller's
// parentOperations / rootOperations after the primary mutation already
// landed on the snapshot.
//
// FriendlyIds (not internal cuids) because the consuming
// `routeOperationsToRun` helper gates on the `run_…` prefix to decide
// whether to attempt the buffer fallback; cuids would skip that path.
// The snapshot's `parentTaskRunId` / `rootTaskRunId` are engine-side
// cuids, so we convert via `RunId.toFriendlyId` here — identical to
// what `readFallback.server.ts` does when assembling its SyntheticRun.
export type ApplyMetadataMutationOutcome =
  | {
      kind: "applied";
      newMetadata: Record<string, unknown>;
      parentTaskRunFriendlyId: string | undefined;
      rootTaskRunFriendlyId: string | undefined;
    }
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "version_exhausted" }
  // Mirrors the PG-side `MetadataTooLargeError` (status 413). Carries
  // the limit + observed size so the route can produce a useful body.
  | { kind: "metadata_too_large"; maximumSize: number; observedSize: number };

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
  // Byte-size cap on the resulting metadata payload, mirroring the
  // PG-side `UpdateMetadataService.maximumSize` (sourced from
  // `env.TASK_RUN_METADATA_MAXIMUM_SIZE`). Required so the buffer path
  // doesn't silently allow writes the PG path would have rejected.
  maximumSize: number;
  body: Pick<FlushedRunMetadata, "metadata" | "operations">;
  buffer?: MollifierBuffer | null;
  maxRetries?: number;
  // Jittered conflict-backoff envelope: random in [0, base + attempt * step) ms.
  backoffBaseMs?: number;
  backoffStepMs?: number;
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
  const backoffBaseMs = input.backoffBaseMs ?? 5;
  const backoffStepMs = input.backoffStepMs ?? 5;
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

    // Capture parent/root ids during this read so the caller can fan
    // parent/root operations out without a second buffer.getEntry. If
    // the drainer's terminal-failure path runs between our CAS-write
    // below and the route's follow-up, the entry hash would be DELd
    // and a second read would return null — silently dropping the
    // caller's `body.parentOperations` / `body.rootOperations`. The ids
    // themselves are immutable for a run, so capturing them on any
    // loop iteration is fine.
    const snapshotParentTaskRunInternalId =
      typeof snapshot.parentTaskRunId === "string" ? snapshot.parentTaskRunId : undefined;
    const snapshotParentTaskRunFriendlyId = snapshotParentTaskRunInternalId
      ? RunId.toFriendlyId(snapshotParentTaskRunInternalId)
      : undefined;
    const snapshotRootTaskRunInternalId =
      typeof snapshot.rootTaskRunId === "string" ? snapshot.rootTaskRunId : undefined;
    const snapshotRootTaskRunFriendlyId = snapshotRootTaskRunInternalId
      ? RunId.toFriendlyId(snapshotRootTaskRunInternalId)
      : undefined;

    // Match PG semantics: `body.operations` and `body.metadata` are
    // mutually exclusive on a single request. The PG service
    // (`UpdateMetadataService.#updateRunMetadata`) branches on
    // `Array.isArray(body.operations)` — if operations are present it
    // applies them on top of the EXISTING metadata and ignores
    // `body.metadata` entirely; otherwise `body.metadata` is the new
    // full value. Doing both here would make a request like
    // `{ metadata: {b:2}, operations: [set c=3] }` produce
    // `{b:2,c:3}` on the buffer vs `{a:1,c:3}` on PG, which silently
    // changes semantics across the buffered/materialised boundary.
    const parseSnapshotMetadata = (): Record<string, unknown> => {
      if (typeof snapshot.metadata !== "string") return {};
      try {
        return JSON.parse(snapshot.metadata) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    let metadataObject: Record<string, unknown>;
    // Use `Array.isArray` (the PG service's predicate) instead of a
    // truthy length check. For `{ metadata, operations: [] }` PG sees
    // Array.isArray([])=true and no-ops on existing metadata; a
    // `.length` check would treat the empty array as falsy and fall
    // through to the `body.metadata` branch, replacing metadata —
    // exactly the cross-boundary drift the comment above warns
    // against.
    if (Array.isArray(input.body.operations)) {
      // Operations take precedence: apply on top of existing snapshot
      // metadata; ignore `body.metadata` to match PG behaviour.
      metadataObject = applyMetadataOperations(
        parseSnapshotMetadata(),
        input.body.operations,
      ).newMetadata;
    } else if (input.body.metadata !== undefined) {
      // No operations — full replace.
      metadataObject = input.body.metadata as Record<string, unknown>;
    } else {
      // Neither — write back existing snapshot metadata (no-op shape).
      metadataObject = parseSnapshotMetadata();
    }

    const newMetadataStr = JSON.stringify(metadataObject);

    // Size cap — match PG (`handleMetadataPacket` throws
    // `MetadataTooLargeError` (413) when the JSON-encoded packet
    // exceeds the configured cap). Reject in-loop, before CAS, so a
    // single oversize write doesn't churn the retry budget.
    const observedSize = Buffer.byteLength(newMetadataStr, "utf8");
    if (observedSize > input.maximumSize) {
      return {
        kind: "metadata_too_large",
        maximumSize: input.maximumSize,
        observedSize,
      };
    }

    const cas = await buffer.casSetMetadata({
      runId: input.runId,
      expectedVersion: entry.metadataVersion,
      newMetadata: newMetadataStr,
      newMetadataType: currentMetadataType,
    });

    if (cas.kind === "applied") {
      return {
        kind: "applied",
        newMetadata: metadataObject,
        parentTaskRunFriendlyId: snapshotParentTaskRunFriendlyId,
        rootTaskRunFriendlyId: snapshotRootTaskRunFriendlyId,
      };
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
    const backoffMs = Math.floor(Math.random() * (backoffBaseMs + attempt * backoffStepMs));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  logger.warn("applyMetadataMutationToBufferedRun: retries exhausted", {
    runId: input.runId,
    maxRetries,
  });
  return { kind: "version_exhausted" };
}
