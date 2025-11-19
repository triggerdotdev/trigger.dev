import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  type CreateArtifactResponseBody,
  CreateArtifactRequestBody,
  tryCatch,
} from "@trigger.dev/core/v3";
import { authenticateRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ArtifactsService } from "~/v3/services/artifacts.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const authenticationResult = await authenticateRequest(request, {
    apiKey: true,
    organizationAccessToken: false,
    personalAccessToken: false,
  });

  if (!authenticationResult || !authenticationResult.result.ok) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const [, rawBody] = await tryCatch(request.json());
  const body = CreateArtifactRequestBody.safeParse(rawBody ?? {});

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const { environment: authenticatedEnv } = authenticationResult.result;

  const service = new ArtifactsService();
  return await service
    .createArtifact(body.data.type, authenticatedEnv, body.data.contentLength)
    .match(
      (result) => {
        return json(
          {
            artifactKey: result.artifactKey,
            uploadUrl: result.uploadUrl,
            uploadFields: result.uploadFields,
            expiresAt: result.expiresAt.toISOString(),
          } satisfies CreateArtifactResponseBody,
          { status: 201 }
        );
      },
      (error) => {
        switch (error.type) {
          case "artifact_size_exceeds_limit": {
            logger.warn("Artifact size exceeds limit", { error });
            return json(
              {
                error: `Artifact size (${error.contentLength} bytes) exceeds the allowed limit of ${error.sizeLimit} bytes`,
              },
              { status: 400 }
            );
          }
          case "failed_to_create_presigned_post": {
            logger.error("Failed to create presigned POST", { error });
            return json({ error: "Failed to generate artifact upload URL" }, { status: 500 });
          }
          default:
            error satisfies never;
            logger.error("Failed creating artifact", { error });
            return json({ error: "Internal server error" }, { status: 500 });
        }
      }
    );
}
