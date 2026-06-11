import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3/schemas";
import { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
// Aliased to avoid shadowing the local `env: AuthenticatedEnvironment`
// parameter the route handler and `routeOperationsToRun` use.
import { env as appEnv } from "~/env.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

// GET handler added to fix the pre-existing route bug where this URL
// returned a Remix "no loader" 400 — only PUT (update) was exported, so
// GET had no handler. Returns `{ metadata, metadataType }` from either
// the Postgres row or the mollifier buffer snapshot.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const env = authenticationResult.environment;

  const pgRun = await $replica.taskRun.findFirst({
    where: { friendlyId: parsed.data.runId, runtimeEnvironmentId: env.id },
    select: { metadata: true, metadataType: true },
  });
  if (pgRun) {
    return json({ metadata: pgRun.metadata, metadataType: pgRun.metadataType }, { status: 200 });
  }

  const buffered = await findRunByIdWithMollifierFallback({
    runId: parsed.data.runId,
    environmentId: env.id,
    organizationId: env.organizationId,
  });
  if (buffered) {
    return json(
      {
        metadata: buffered.metadata ?? null,
        metadataType: buffered.metadataType ?? "application/json",
      },
      { status: 200 }
    );
  }

  return json({ error: "Run not found" }, { status: 404 });
}

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
  if (!error && result !== undefined) return;

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

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: UpdateMetadataRequestBody,
    maxContentLength: 1024 * 1024 * 2, // 2MB
    method: "PUT",
  },
  async ({ authentication, body, params }) => {
    const env = authentication.environment;
    const runId = params.runId;

    // PG-canonical path. If the run is in PG, the existing service
    // owns the full request shape including parent/root operations,
    // metadataVersion CAS, batching, validation — none of which the
    // buffer side needs to reimplement.
    const [pgError, pgResult] = await tryCatch(
      updateMetadataService.call(runId, body, env)
    );
    if (pgError) {
      if (pgError instanceof ServiceValidationError) {
        return json({ error: pgError.message }, { status: pgError.status ?? 422 });
      }
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
    if (pgResult) {
      // Reflect metadata.set() on a live feed before the next lifecycle event. Publish the
      // internal id (the router keys single-run feeds by it, not the friendly id from the URL).
      publishChangeRecord({
        runId: pgResult.runId,
        envId: env.id,
        tags: pgResult.runTags,
        batchId: pgResult.batchId,
      });
      return json({ metadata: pgResult.metadata }, { status: 200 });
    }

    // PG miss. Target run is either buffered or genuinely absent.
    const bufferOutcome = await applyMetadataMutationToBufferedRun({
      runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      maximumSize: appEnv.TASK_RUN_METADATA_MAXIMUM_SIZE,
      maxRetries: appEnv.TRIGGER_MOLLIFIER_METADATA_MAX_RETRIES,
      backoffBaseMs: appEnv.TRIGGER_MOLLIFIER_METADATA_BACKOFF_BASE_MS,
      backoffStepMs: appEnv.TRIGGER_MOLLIFIER_METADATA_BACKOFF_STEP_MS,
      body: { metadata: body.metadata, operations: body.operations },
    });

    if (bufferOutcome.kind === "not_found") {
      return json({ error: "Task Run not found" }, { status: 404 });
    }
    if (bufferOutcome.kind === "metadata_too_large") {
      // Mirror PG's `MetadataTooLargeError` (413).
      return json(
        {
          error: `Metadata exceeds maximum size of ${bufferOutcome.maximumSize} bytes`,
        },
        { status: 413 }
      );
    }
    if (bufferOutcome.kind === "busy") {
      // Entry is materialising. Best path is to retry the PG call —
      // the row may be visible now. We don't waste a roundtrip in
      // the happy path, but a 503 here would be customer-visible
      // breakage for legitimately-burst workloads. Hand back 503 with
      // a retry hint; SDK retry policy converges.
      return json({ error: "Run materialising, retry shortly" }, { status: 503 });
    }
    if (bufferOutcome.kind === "version_exhausted") {
      // Pathological contention — many concurrent metadata writers on
      // the same buffered runId. Surface as 503 rather than silently
      // dropping the request.
      return json({ error: "Metadata write contention; retry shortly" }, { status: 503 });
    }

    // Buffered metadata mutation succeeded. Fan parent/root operations
    // out to their respective runs (parent/root are typically PG-
    // materialised by the time the child is buffered, so the existing
    // service handles them; if they're also buffered, the helper
    // recurses through the buffered mutation path).
    //
    // Use the parent/root friendlyIds the buffered mutation captured
    // during its internal read — NOT a second `findRunByIdWithMollifierFallback`
    // call here. The drainer's terminal-failure path DELetes the entry
    // hash atomically, so if it fires between the primary mutation
    // landing and our route's second read, `bufferedEntry` would come
    // back null and the route would silently drop `parentOperations` /
    // `rootOperations` after the customer's primary mutation already
    // landed on the snapshot. Capturing the ids in the helper's first
    // CAS read closes that race.
    //
    // Self-fallback to `runId` matches PG semantics: the PG service
    // routes to `taskRun.parentTaskRun?.id ?? taskRun.id` and
    // `taskRun.rootTaskRun?.id ?? taskRun.id`, so a top-level run's
    // parent/root ops land on itself rather than being silently
    // dropped.
    await Promise.all([
      routeOperationsToRun(
        bufferOutcome.parentTaskRunFriendlyId ?? runId,
        body.parentOperations,
        env,
      ),
      routeOperationsToRun(
        bufferOutcome.rootTaskRunFriendlyId ?? runId,
        body.rootOperations,
        env,
      ),
    ]);

    // Wire-shape parity with the PG branch. `UpdateMetadataService.call`
    // returns `{ metadata: <object> }` (see `updateMetadata.server.ts:356-358`),
    // sourced from `applyResults.newMetadata` / `parsePacket(metadataPacket)`
    // — both parsed `Record<string, unknown>`. `bufferOutcome.newMetadata`
    // is typed identically (`applyMetadataMutation.server.ts:27`). SDK
    // consumers see the same response shape regardless of which branch
    // serves the request.
    return json({ metadata: bufferOutcome.newMetadata }, { status: 200 });
  }
);

export { action };
