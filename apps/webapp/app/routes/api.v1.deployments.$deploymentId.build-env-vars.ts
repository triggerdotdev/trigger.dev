import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type GetDeploymentBuildEnvVarsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { decryptSecret, EncryptedSecretValueSchema } from "~/services/secrets/secretStore.server";
import { FINAL_DEPLOYMENT_STATUSES } from "~/v3/services/failDeployment.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

// Secret material, deliberately separate from the main GET deployment endpoint.
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

    const authenticatedEnv = authResult.authentication.environment;

    const { deploymentId } = parsedParams.data;

    const deployment = await prisma.workerDeployment.findFirst({
      where: {
        friendlyId: deploymentId,
        environmentId: authenticatedEnv.id,
      },
      select: {
        id: true,
        status: true,
        buildEnvVars: true,
      },
    });

    if (!deployment) {
      return json({ error: "Deployment not found" }, { status: 404 });
    }

    logger.info("Build env vars read", {
      deploymentId,
      environmentId: authenticatedEnv.id,
      projectId: authenticatedEnv.projectId,
      status: deployment.status,
      hasVars: deployment.buildEnvVars !== null,
    });

    // Never serve secrets for a build that is no longer active, even if a clear is still in flight
    if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      return json({ variables: {} } satisfies GetDeploymentBuildEnvVarsResponseBody, {
        status: 200,
      });
    }

    if (!deployment.buildEnvVars) {
      return json({ variables: {} } satisfies GetDeploymentBuildEnvVarsResponseBody, {
        status: 200,
      });
    }

    // Present-but-unreadable must fail loud: an empty record would let the build run without its secrets
    const envelope = EncryptedSecretValueSchema.safeParse(deployment.buildEnvVars);

    if (!envelope.success) {
      logger.error("Stored build env vars are not a valid encrypted envelope", {
        deploymentId,
        environmentId: authenticatedEnv.id,
      });
      return json(
        { error: "The stored build environment variables could not be read. Retry the deploy." },
        { status: 500 }
      );
    }

    let variables: Record<string, string>;

    try {
      const decrypted = await decryptSecret(env.ENCRYPTION_KEY, envelope.data);
      variables = z.record(z.string()).parse(JSON.parse(decrypted));
    } catch (error) {
      logger.error("Failed to decrypt stored build env vars", {
        deploymentId,
        environmentId: authenticatedEnv.id,
        error,
      });
      return json(
        {
          error: "The stored build environment variables could not be decrypted. Retry the deploy.",
        },
        { status: 500 }
      );
    }

    return json({ variables } satisfies GetDeploymentBuildEnvVarsResponseBody, { status: 200 });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load deployment build env vars", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
