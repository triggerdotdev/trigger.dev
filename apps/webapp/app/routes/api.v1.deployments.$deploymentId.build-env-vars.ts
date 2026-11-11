import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { deploymentBuildEnvVarsResponse } from "~/services/deploymentBuildEnvVars.server";
import { environmentEncryption } from "~/services/environmentEncryption/instance.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({ deploymentId: z.string() });

// Secret material: needs write, like the build's own progress and finalize calls.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) return json({ error: "Invalid params" }, { status: 400 });
  try {
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "write",
      resource: { type: "deployments" },
    });
    if (!authResult.ok) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }
    return deploymentBuildEnvVarsResponse({
      db: prisma,
      encryption: environmentEncryption(),
      environment: authResult.authentication.environment,
      deploymentId: parsedParams.data.deploymentId,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load deployment build env vars", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
