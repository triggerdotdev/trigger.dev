import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3/schemas";
import { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

// Phase A6 — fixes the pre-existing route bug where GET on this URL
// returned a Remix "no loader" 400. The route only exposed PUT (update);
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
async function routeOperationsToRun(
  targetRunId: string | undefined,
  operations: RunMetadataChangeOperation[] | undefined,
  env: { id: string; organizationId: string }
): Promise<void> {
  if (!targetRunId || !operations || operations.length === 0) return;

  // Try PG first via the existing service (this is how parent/root
  // operations have always landed; preserve that).
  const [error] = await tryCatch(
    updateMetadataService.call(
      targetRunId,
      { operations },
      { id: env.id, organizationId: env.organizationId } as unknown as Parameters<
        typeof updateMetadataService.call
      >[2]
    )
  );
  if (!error) return;

  // PG service threw — could be "Cannot update metadata for a completed
  // run" or similar. If the target is buffered, route operations to its
  // snapshot too. Best-effort; do not surface this failure to the
  // caller — the parent/root ops are auxiliary.
  await applyMetadataMutationToBufferedRun({
    runId: targetRunId,
    body: { operations },
  });
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
      return json(pgResult, { status: 200 });
    }

    // PG miss. Target run is either buffered or genuinely absent.
    const bufferOutcome = await applyMetadataMutationToBufferedRun({
      runId,
      body: { metadata: body.metadata, operations: body.operations },
    });

    if (bufferOutcome.kind === "not_found") {
      return json({ error: "Task Run not found" }, { status: 404 });
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
    const bufferedEntry = await findRunByIdWithMollifierFallback({
      runId,
      environmentId: env.id,
      organizationId: env.organizationId,
    });
    if (bufferedEntry) {
      await Promise.all([
        routeOperationsToRun(bufferedEntry.parentTaskRunId, body.parentOperations, env),
        // The snapshot doesn't carry rootTaskRunId; fall back to parent
        // as a rough proxy (matches the existing service's nil-coalesce
        // behaviour where rootTaskRun defaults to the parent). Phase D
        // / future work could thread rootTaskRunId through the snapshot.
        routeOperationsToRun(bufferedEntry.parentTaskRunId, body.rootOperations, env),
      ]);
    }

    return json({ metadata: bufferOutcome.newMetadata }, { status: 200 });
  }
);

export { action };
