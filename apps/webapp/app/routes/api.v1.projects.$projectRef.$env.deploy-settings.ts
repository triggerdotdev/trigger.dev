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

const ENV_SLUG_FOR_TYPE = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
} as const;

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

    const { environment } = authResult.authentication;
    const { projectRef, env } = parsedParams.data;

    if (
      environment.project.externalRef !== projectRef ||
      ENV_SLUG_FOR_TYPE[environment.type] !== env
    ) {
      return json(
        { error: "API key does not belong to this project environment" },
        { status: 403 }
      );
    }

    const deploymentService = new DeploymentService();

    return await deploymentService.getDeploySettings(environment).match(
      ({ buildPath, buildPathSource }) => {
        logger.info("Resolved deploy build path", {
          environmentId: environment.id,
          projectRef,
          env,
          buildPath,
          buildPathSource,
        });

        return json({ build_path: buildPath } satisfies GetDeploySettingsResponseBody);
      },
      (error) => {
        switch (error.type) {
          case "other":
          default:
            error.type satisfies "other";
            logger.error("Failed to resolve deploy settings", { error: error.cause });
            return json({ error: "Internal server error" }, { status: 500 });
        }
      }
    );
  } catch (error) {
    logger.error("Failed to resolve deploy settings", { error });
    return json({ error: "Internal server error" }, { status: 500 });
  }
}
