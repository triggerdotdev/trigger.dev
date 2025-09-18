import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { type WorkerDeployment } from "@trigger.dev/database";
import { type GitMeta } from "@trigger.dev/core/v3";

export class DeploymentService extends BaseService {
  public async startDeployment(
    authenticatedEnv: AuthenticatedEnvironment,
    friendlyId: string,
    updates: Partial<Pick<WorkerDeployment, "contentHash" | "runtime"> & { git: GitMeta }>
  ) {
    const getDeployment = () =>
      fromPromise(
        this._prisma.workerDeployment.findFirst({
          where: {
            friendlyId,
            environmentId: authenticatedEnv.id,
          },
          select: {
            status: true,
            id: true,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((deployment) => {
        if (!deployment) {
          return errAsync({ type: "deployment_not_found" as const });
        }
        return okAsync(deployment);
      });

    const validateDeployment = (deployment: Pick<WorkerDeployment, "id" | "status">) => {
      if (deployment.status !== "PENDING") {
        return errAsync({ type: "deployment_not_pending" as const });
      }

      return okAsync(deployment);
    };

    const updateDeployment = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(
        this._prisma.workerDeployment.updateMany({
          where: { id: deployment.id, status: "PENDING" }, // status could've changed in the meantime, we're not locking the row
          data: { ...updates, status: "BUILDING" },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((result) => {
        if (result.count === 0) {
          return errAsync({ type: "deployment_not_pending" as const });
        }
        return okAsync(undefined);
      });

    return getDeployment().andThen(validateDeployment).andThen(updateDeployment);
  }
}
