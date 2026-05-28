import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";
import type {
  BackgroundWorker,
  PrismaClientOrTransaction,
  WorkerDeployment,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "../common.server";
import { stripBackgroundWorkerMetadataForStorage } from "../stripBackgroundWorkerMetadataForStorage.server";

/**
 * Idempotent on `(project, environment, version)` for sequential calls, not concurrent calls.
 */
export async function findOrCreateBackgroundWorker(
  environment: AuthenticatedEnvironment,
  deployment: WorkerDeployment,
  body: CreateBackgroundWorkerRequestBody,
  prisma: PrismaClientOrTransaction
): Promise<BackgroundWorker> {
  const existing = await prisma.backgroundWorker.findFirst({
    where: {
      projectId: environment.projectId,
      runtimeEnvironmentId: environment.id,
      version: deployment.version,
    },
  });

  if (existing && existing.contentHash === body.metadata.contentHash) {
    return existing;
  }

  if (existing) {
    throw new ServiceValidationError(
      "A background worker for this deployment version already exists with a different content hash",
      409
    );
  }

  return prisma.backgroundWorker.create({
    data: {
      ...BackgroundWorkerId.generate(),
      version: deployment.version,
      runtimeEnvironmentId: environment.id,
      projectId: environment.projectId,
      metadata: stripBackgroundWorkerMetadataForStorage(body.metadata),
      contentHash: body.metadata.contentHash,
      cliVersion: body.metadata.cliPackageVersion,
      sdkVersion: body.metadata.packageVersion,
      supportsLazyAttempts: body.supportsLazyAttempts,
      engine: body.engine,
      runtime: body.metadata.runtime,
      runtimeVersion: body.metadata.runtimeVersion,
    },
  });
}
