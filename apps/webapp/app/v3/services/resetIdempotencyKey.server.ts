import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService, ServiceValidationError } from "./baseService.server";

export class ResetIdempotencyKeyService extends BaseService {
  public async call(
    idempotencyKey: string,
    taskIdentifier: string,
    authenticatedEnv: AuthenticatedEnvironment
  ): Promise<{ id: string }> {
    // Find all runs with this idempotency key and task identifier in the authenticated environment
    const runs = await this._prisma.taskRun.findMany({
      where: {
        idempotencyKey,
        taskIdentifier,
        runtimeEnvironmentId: authenticatedEnv.id,
      },
      select: {
        id: true,
      },
    });

    if (runs.length === 0) {
      throw new ServiceValidationError(
        `No runs found with idempotency key: ${idempotencyKey} and task: ${taskIdentifier}`,
        404
      );
    }

    // Update all runs to clear the idempotency key
    await this._prisma.taskRun.updateMany({
      where: {
        idempotencyKey,
        taskIdentifier,
        runtimeEnvironmentId: authenticatedEnv.id,
      },
      data: {
        idempotencyKey: null,
        idempotencyKeyExpiresAt: null,
      },
    });

    return { id: idempotencyKey };
  }
}
