import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { updateMetadataService } from "~/services/metadata/updateMetadataInstance.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";
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
    // Buffered snapshot stores metadata as the original packet shape
    // (could be a string for application/json payloads). Pass through
    // without re-encoding — the consumer expects the same shape PG would
    // return.
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

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: UpdateMetadataRequestBody,
    maxContentLength: 1024 * 1024 * 2, // 2MB
    method: "PUT",
  },
  async ({ authentication, body, params }) => {
    const [error, result] = await tryCatch(
      updateMetadataService.call(params.runId, body, authentication.environment)
    );

    if (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      }

      return json({ error: "Internal Server Error" }, { status: 500 });
    }

    if (!result) {
      return json({ error: "Task Run not found" }, { status: 404 });
    }

    return json(result, { status: 200 });
  }
);

export { action };
