import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
// Aliased to avoid shadowing the local `env` parameter in the handler.
import { env as appEnv } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { publishChangeRecord } from "~/services/realtime/runChangeNotifierInstance.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import { routeOperationsToRun } from "~/v3/mollifier/routeOperationsToRun.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { runStore } from "~/v3/runStore.server";

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

  const pgRun = await runStore.findRun(
    { friendlyId: parsed.data.runId, runtimeEnvironmentId: env.id },
    { select: { metadata: true, metadataType: true } },
    $replica
  );
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

  // Read-your-writes: a run drained from the buffer to the primary but not yet replicated misses
  // both the replica read and the buffer. Re-read the owning primary before 404ing.
  const primaryRun = await runStore.findRunOnPrimary(
    { friendlyId: parsed.data.runId, runtimeEnvironmentId: env.id },
    { select: { metadata: true, metadataType: true } }
  );
  if (primaryRun) {
    return json(
      { metadata: primaryRun.metadata, metadataType: primaryRun.metadataType },
      { status: 200 }
    );
  }

  return json({ error: "Run not found" }, { status: 404 });
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
    const [pgError, pgResult] = await tryCatch(updateMetadataService.call(runId, body, env));
    if (pgError) {
      if (pgError instanceof ServiceValidationError) {
        return json({ error: pgError.message }, { status: pgError.status ?? 422 });
      }
      return json({ error: "Internal Server Error" }, { status: 500 });
    }
    if (pgResult) {
      // Reflect metadata.set() on a live feed before the next lifecycle event. Publish the
      // internal id (the router keys single-run feeds by it, not the friendly id from the
      // URL) with the committed updatedAt as the read-your-writes watermark. No write
      // (no-op body, or ops buffered for the flusher) means nothing to announce here.
      if (pgResult.updatedAtMs !== undefined) {
        publishChangeRecord({
          runId: pgResult.runId,
          envId: env.id,
          tags: pgResult.runTags,
          batchId: pgResult.batchId,
          updatedAtMs: pgResult.updatedAtMs,
        });
      }
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
        env
      ),
      routeOperationsToRun(bufferOutcome.rootTaskRunFriendlyId ?? runId, body.rootOperations, env),
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
