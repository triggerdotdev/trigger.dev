import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetDeploySettingsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { isBillingConfigured } from "~/services/platform.v3.server";
import { BuildSettingsSchema } from "~/v3/buildSettings";
import { resolveDeployBuildPath } from "~/v3/deployBuildPath";
import { flags } from "~/v3/featureFlags.server";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

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

  const authResult = await authenticateApiKeyWithScope(request, {
    action: "read",
    resource: { type: "deployments" },
  });

  if (!authResult.ok) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: authResult.error }, { status: authResult.status });
  }

  const environment = authResult.authentication.environment;
  const { projectRef, env } = parsedParams.data;

  if (
    environment.project.externalRef !== projectRef ||
    ENV_SLUG_FOR_TYPE[environment.type] !== env
  ) {
    return json({ error: "API key does not belong to this project environment" }, { status: 403 });
  }

  try {
    const project = await $replica.project.findFirst({
      where: { id: environment.project.id },
      select: { buildSettings: true },
    });

    const build = resolveDeployBuildPath({
      environmentType: environment.type,
      orgFeatureFlags: environment.organization.featureFlags,
      globalFlags: globalFlagsRegistry.current() ?? (await flags()),
      projectBuildSettings: BuildSettingsSchema.safeParse(project?.buildSettings).data,
      nativeBuildServerAvailable: isBillingConfigured(),
    });

    logger.debug("Resolved deploy settings", {
      environmentId: environment.id,
      projectRef,
      build,
    });

    const body: GetDeploySettingsResponseBody = { build };
    return json(body);
  } catch (error) {
    logger.error("Failed to resolve deploy settings", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
