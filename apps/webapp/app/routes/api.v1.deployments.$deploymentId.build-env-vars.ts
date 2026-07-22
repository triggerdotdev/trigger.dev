import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type GetDeploymentBuildEnvVarsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { decryptSecret, EncryptedSecretValueSchema } from "~/services/secrets/secretStore.server";
import { FINAL_DEPLOYMENT_STATUSES } from "~/v3/services/failDeployment.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

// Returns the decrypted build-time env vars stored on a fromBundle deployment.
// Deliberately separate from the main GET deployment endpoint: this is secret
// material, and a dedicated route keeps access explicit and auditable. The vars
// are cleared when the deployment reaches a terminal status, so this only ever
// serves the active build window.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    // Next authenticate the request
    const authenticationResult = await authenticateApiRequest(request);

    if (!authenticationResult) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const authenticatedEnv = authenticationResult.environment;

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

    // Terminal deployments have their vars cleared; even if a clear is still in
    // flight, never serve secrets for a build that is no longer active.
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

    // Vars exist but can't be read: fail LOUD. Returning an empty record here would
    // be indistinguishable from "there were none" and let the build run without its
    // build-time secrets (confusing failure at best, silently-wrong image at worst).
    // Concrete trigger: ENCRYPTION_KEY rotation during the build window.
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
