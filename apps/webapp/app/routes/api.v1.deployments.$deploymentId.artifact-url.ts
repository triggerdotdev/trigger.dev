import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type GetDeploymentArtifactUrlResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ArtifactsService } from "~/v3/services/artifacts.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "write",
      resource: { type: "deployments" },
    });

    if (!authResult.ok) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }

    const authenticatedEnv = authResult.authentication.environment;
    const { deploymentId } = parsedParams.data;
    const logContext = {
      deploymentId,
      environmentId: authenticatedEnv.id,
      projectId: authenticatedEnv.projectId,
    };

    return await new ArtifactsService()
      .createDeploymentDownloadUrl(authenticatedEnv, deploymentId)
      .match(
        ({ url, expiresAt }) => {
          logger.info("Issued deployment artifact download URL", logContext);
          return json(
            {
              url,
              expiresAt: expiresAt.toISOString(),
            } satisfies GetDeploymentArtifactUrlResponseBody,
            { headers: { "Cache-Control": "private, no-store" } }
          );
        },
        (error) => {
          switch (error.type) {
            case "development_environment":
              return json(
                { error: "Deployments are not supported in development environments" },
                { status: 400 }
              );
            case "deployment_not_found":
              return json({ error: "deployment_not_found" }, { status: 404 });
            case "artifact_not_found":
              return json({ error: "artifact_not_found" }, { status: 404 });
            case "artifact_key_not_owned":
              logger.warn("Deployment artifact key does not belong to the environment", {
                ...logContext,
                key: error.key,
              });
              return json({ error: "artifact_not_found" }, { status: 404 });
            case "artifacts_bucket_not_configured":
              logger.error("Artifacts bucket is not configured", logContext);
              return json({ error: "Internal server error" }, { status: 500 });
            case "failed_to_check_artifact":
            case "failed_to_create_download_url":
              logger.error("Failed to create deployment artifact download URL", {
                ...logContext,
                error: error.cause,
              });
              return json({ error: "Internal server error" }, { status: 500 });
            case "other":
            default:
              error.type satisfies "other";
              logger.error("Failed to load deployment for artifact download URL", {
                ...logContext,
                error: error.cause,
              });
              return json({ error: "Internal server error" }, { status: 500 });
          }
        }
      );
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to create deployment artifact download URL", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
