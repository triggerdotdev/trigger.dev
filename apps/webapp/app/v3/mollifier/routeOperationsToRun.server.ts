import { tryCatch } from "@trigger.dev/core/utils";
import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3/schemas";
import { env as appEnv } from "~/env.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";
import { applyMetadataMutationToBufferedRun } from "./applyMetadataMutation.server";

// Route parent/root operations to the existing PG service by directly
// invoking it against the parent/root runId. The service ingests via
// its batching worker, which targets PG by id. If the parent/root is
// itself buffered we recurse through our buffered-mutation helper.
// `_ingestion_only` flag: a synthetic body that has the operations
// promoted to top-level `operations` so the service applies them to
// `targetRunId` directly.
// Exported so the silent-failure logging behaviour can be unit-tested.
// The route handler itself isn't an attractive test target (createActionApiRoute
// wraps it in auth + body parsing + error-handler middleware), but the
// fan-out helper carries the load-bearing logic — including the ops-
// visibility branch this change adds.
export async function routeOperationsToRun(
  targetRunId: string | undefined,
  operations: RunMetadataChangeOperation[] | undefined,
  env: AuthenticatedEnvironment
): Promise<void> {
  if (!targetRunId || !operations || operations.length === 0) return;

  // Try PG first via the existing service (this is how parent/root
  // operations have always landed; preserve that). Accepts the full
  // AuthenticatedEnvironment so we don't have to recover the unsafe
  // `as unknown` cast that the previous narrowed `{ id, organizationId }`
  // signature forced on us.
  //
  // Two non-success outcomes from `call`:
  //   * throws — PG threw (e.g. "Cannot update metadata for a completed
  //     run", or a transient PG outage).
  //   * resolves with undefined — PG row didn't exist (the target may be
  //     buffered, not yet materialised).
  // Either way we want to try the buffer fallback below; treating the
  // undefined-return as success would make the fallback unreachable.
  const [error, result] = await tryCatch(
    updateMetadataService.call(targetRunId, { operations }, env)
  );
  if (!error && result !== undefined) {
    // The parent/root run changed too — wake its live feeds (only when something was
    // actually written here; buffered writes publish from the flusher).
    if (result.updatedAtMs !== undefined) {
      publishChangeRecord({
        runId: result.runId,
        envId: env.id,
        tags: result.runTags,
        batchId: result.batchId,
        updatedAtMs: result.updatedAtMs,
      });
    }
    return;
  }

  if (error) {
    // PG threw — auxiliary op, stay best-effort and don't surface this
    // to the caller (the caller's primary mutation already landed). But
    // warn so a genuine PG outage on these ops isn't invisible.
    logger.warn("metadata route: parent/root PG op failed", {
      targetRunId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Buffer fallback only makes sense for friendlyId-keyed entries. The
  // PG-side parent/root IDs are internal cuids; the buffer keys entries
  // by friendlyId, so passing the internal id would silently no-op.
  // Skip explicitly — a buffered child's parent is always materialised
  // in PG already (a buffered run hasn't executed, so it can't have
  // triggered the child), so the buffered-parent branch isn't actually
  // reachable. Treating the no-op as intentional rather than incidental.
  if (!targetRunId.startsWith("run_")) return;

  // Best-effort buffer fallback. Wrap so a transient Redis throw on
  // this auxiliary op can't 500 the request after the primary mutation
  // already succeeded.
  const [bufferError, bufferOutcome] = await tryCatch(
    applyMetadataMutationToBufferedRun({
      runId: targetRunId,
      environmentId: env.id,
      organizationId: env.organizationId,
      maximumSize: appEnv.TASK_RUN_METADATA_MAXIMUM_SIZE,
      maxRetries: appEnv.TRIGGER_MOLLIFIER_METADATA_MAX_RETRIES,
      backoffBaseMs: appEnv.TRIGGER_MOLLIFIER_METADATA_BACKOFF_BASE_MS,
      backoffStepMs: appEnv.TRIGGER_MOLLIFIER_METADATA_BACKOFF_STEP_MS,
      body: { operations },
    })
  );
  if (bufferError) {
    logger.warn("metadata route: buffer fallback for parent/root op failed", {
      targetRunId,
      error: bufferError instanceof Error ? bufferError.message : String(bufferError),
    });
    return;
  }
  // `applyMetadataMutationToBufferedRun` reports non-throw failures via
  // its returned outcome kind: `not_found`, `busy`, `version_exhausted`,
  // `metadata_too_large`. Without inspecting `.kind`, the parent/root
  // operation can silently disappear — no PG row landed it (handled
  // above) and the buffer rejected it for one of these reasons but the
  // helper returned cleanly. Surface a warn log per non-success branch
  // so ops can trace why a parent/root op went missing. The customer's
  // primary mutation has already succeeded by this point; this remains
  // best-effort, so we still don't bubble these to the response.
  if (bufferOutcome && bufferOutcome.kind !== "applied") {
    logger.warn("metadata route: parent/root buffer op did not apply", {
      targetRunId,
      kind: bufferOutcome.kind,
    });
  }
}
