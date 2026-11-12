import { json } from "@remix-run/server-runtime";
import type { GetDeploymentBuildEnvVarsResponseBody } from "@trigger.dev/core/v3";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { StoredEnvironmentValueSchema } from "~/services/environmentEncryption/crypto.server";
import type { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { environmentEncryptionTelemetry } from "~/services/environmentEncryption/telemetry.server";
import { EnvironmentKeyUnavailableError } from "~/services/environmentEncryption/wrapping.server";
import { FINAL_DEPLOYMENT_STATUSES } from "~/v3/services/failDeployment.server";

export async function deploymentBuildEnvVarsResponse(options: {
  db: PrismaClientOrTransaction;
  encryption: EnvironmentEncryptionService;
  environment: { id: string; projectId: string };
  deploymentId: string;
}) {
  const { db, encryption, environment, deploymentId } = options;
  try {
    const deployment = await db.workerDeployment.findFirst({
      where: { friendlyId: deploymentId, environmentId: environment.id },
      select: { id: true, status: true, buildEnvVars: true },
    });
    if (!deployment) return json({ error: "Deployment not found" }, { status: 404 });

    logger.info("Build env vars read", {
      deploymentId,
      environmentId: environment.id,
      projectId: environment.projectId,
      status: deployment.status,
      hasVars: deployment.buildEnvVars !== null,
    });
    // Final rows keep their envelope for redeploys; only the new in-flight copy is ever served.
    if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status) || !deployment.buildEnvVars) {
      return json({ variables: {} } satisfies GetDeploymentBuildEnvVarsResponseBody);
    }

    const envelope = StoredEnvironmentValueSchema.safeParse(deployment.buildEnvVars);
    if (!envelope.success) {
      logger.error("Stored build env vars are not a valid encrypted envelope", {
        deploymentId,
        environmentId: environment.id,
      });
      return json(
        { error: "The stored build environment variables could not be read. Retry the deploy." },
        { status: 500 }
      );
    }
    const decrypted = (
      await encryption.decryptMany([
        {
          projectId: environment.projectId,
          context: {
            environmentId: environment.id,
            purpose: "build-env-vars",
            objectId: deployment.id,
          },
          value: envelope.data,
        },
      ])
    )[0]!;
    const variables = z.record(z.string(), z.string()).parse(JSON.parse(decrypted));
    return json({ variables } satisfies GetDeploymentBuildEnvVarsResponseBody);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof EnvironmentKeyUnavailableError) {
      environmentEncryptionTelemetry().failures.add(1, { reason: "build_envelope_unavailable" });
      return json({ error: "Environment encryption key unavailable" }, { status: 503 });
    }
    logger.error("Failed to load deployment build env vars", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
