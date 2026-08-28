import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetDeploySettingsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DeploymentService } from "~/v3/services/deployment.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "read",
      resource: { type: "deployments" },
    });

    if (!authResult.ok) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }

    const { environment: authenticatedEnv } = authResult.authentication;
    const { projectRef, env } = parsedParams.data;

    const deploymentService = new DeploymentService();

    return await deploymentService
      .getDeploySettings(authenticatedEnv, { projectRef, envSlug: env })
      .match(
        ({ buildPath, buildPathSource }) => {
          logger.info("Resolved deploy build path", {
            environmentId: authenticatedEnv.id,
            projectRef,
            env,
            buildPath,
            buildPathSource,
          });

          return json({ build_path: buildPath } satisfies GetDeploySettingsResponseBody);
        },
        (error) => {
          switch (error.type) {
            case "environment_mismatch":
              return json(
                { error: "API key does not belong to this project environment" },
                { status: 403 }
              );
            case "failed_to_load_global_flags":
            default:
              error.type satisfies "failed_to_load_global_flags";
              logger.error("Failed to load the global feature flags", { error: error.cause });
              return json({ error: "Internal Server Error" }, { status: 500 });
          }
        }
      );
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to resolve deploy settings", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
