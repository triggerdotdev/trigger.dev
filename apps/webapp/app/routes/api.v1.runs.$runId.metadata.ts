import { json } from "@remix-run/server-runtime";
import { UpdateMetadataRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { updateMetadataService } from "~/services/metadata/updateMetadata.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: UpdateMetadataRequestBody,
    maxContentLength: 1024 * 1024 * 2, // 2MB
    method: "PUT",
  },
  async ({ authentication, body, params }) => {
    const result = await updateMetadataService.call(params.runId, body, authentication.environment);

    if (!result) {
      return json({ error: "Task Run not found" }, { status: 404 });
    }

    return json(result, { status: 200 });
  }
);

export { action };
