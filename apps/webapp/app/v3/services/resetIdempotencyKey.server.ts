import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService, ServiceValidationError } from "./baseService.server";

export class ResetIdempotencyKeyService extends BaseService {
  public async call(
    idempotencyKey: string,
    taskIdentifier: string,
    authenticatedEnv: AuthenticatedEnvironment
  ): Promise<{ id: string }> {
    const { count } = await this._prisma.taskRun.updateMany({
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

    if (count === 0) {
      throw new ServiceValidationError(
        `No runs found with idempotency key: ${idempotencyKey} and task: ${taskIdentifier}`,
        404
      );
    }

    return { id: idempotencyKey };
  }
}
