import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { type WorkerDeploymentStatus, type WorkerDeployment } from "@trigger.dev/database";
import { type ExternalBuildData, logger, type GitMeta } from "@trigger.dev/core/v3";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";

export class DeploymentService extends BaseService {
  public startDeployment(
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
        logger.warn("Attempted starting deployment that is not in PENDING status", {
          deployment,
        });
        return errAsync({ type: "deployment_not_pending" as const });
      }

      return okAsync(deployment);
    };

    const createRemoteBuild = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(createRemoteImageBuild(authenticatedEnv.project), (error) => ({
        type: "failed_to_create_remote_build" as const,
        cause: error,
      })).map((build) => ({
        id: deployment.id,
        externalBuildData: build,
      }));

    const updateDeployment = (
      deployment: Pick<WorkerDeployment, "id"> & {
        externalBuildData: ExternalBuildData | undefined;
      }
    ) =>
      fromPromise(
        this._prisma.workerDeployment.updateMany({
          where: { id: deployment.id, status: "PENDING" }, // status could've changed in the meantime, we're not locking the row
          data: {
            ...updates,
            externalBuildData: deployment.externalBuildData,
            status: "BUILDING",
            startedAt: new Date(),
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((result) => {
        if (result.count === 0) {
          return errAsync({ type: "deployment_not_pending" as const });
        }
        return okAsync({ id: deployment.id });
      });

    const extendTimeout = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(
        TimeoutDeploymentService.enqueue(
          deployment.id,
          "BUILDING" satisfies WorkerDeploymentStatus,
          "Building timed out",
          new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
        ),
        (error) => ({
          type: "failed_to_extend_deployment_timeout" as const,
          cause: error,
        })
      );

    return getDeployment()
      .andThen(validateDeployment)
      .andThen(createRemoteBuild)
      .andThen(updateDeployment)
      .andThen(extendTimeout)
      .map(() => undefined);
  }
}
