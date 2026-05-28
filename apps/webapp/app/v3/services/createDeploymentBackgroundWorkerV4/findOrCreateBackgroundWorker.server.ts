import type { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { BackgroundWorkerId } from "@trigger.dev/core/v3/isomorphic";
import {
  isUniqueConstraintError,
  type BackgroundWorker,
  type PrismaClientOrTransaction,
  type WorkerDeployment,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ServiceValidationError } from "../common.server";
import { stripBackgroundWorkerMetadataForStorage } from "../stripBackgroundWorkerMetadataForStorage.server";

/**
 * Idempotent on `(project, environment, version)` for sequential calls, not concurrent calls.
 *
 * Failure shapes the caller distinguishes:
 *   - `ServiceValidationError` (409): definitive — contentHash drift means a different build
 *     is being pushed under the same deployment version, so the caller should fail the
 *     deployment instead of waiting for a timeout.
 *   - Plain `Error`: transient — two attempts raced the `create()` call and the loser caught
 *     the unique-index violation. The caller should propagate this as 5xx so the CLI's
 *     retry/backoff hits findFirst on the next attempt and returns the winner's row.
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

  try {
    return await prisma.backgroundWorker.create({
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
  } catch (error) {
    // Concurrent attempts raced past `findFirst` and both reached `create`. Surface
    // a clear, non-Prisma error so the 5xx the caller returns isn't an opaque
    // P2002 — the CLI's retry will then hit `findFirst` and find the winner's row.
    // Intentionally NOT a ServiceValidationError so the caller doesn't fail-deploy
    // on a transient race.
    if (
      isUniqueConstraintError(error, ["projectId", "runtimeEnvironmentId", "version"])
    ) {
      throw new Error(
        "Concurrent background worker registration detected for this deployment version; please retry"
      );
    }
    throw error;
  }
}
