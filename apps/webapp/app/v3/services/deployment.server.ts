import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { errAsync, fromPromise, okAsync } from "neverthrow";
import { type WorkerDeployment } from "@trigger.dev/database";
import { logger, type GitMeta } from "@trigger.dev/core/v3";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";
import { FINAL_DEPLOYMENT_STATUSES } from "./failDeployment.server";

export class DeploymentService extends BaseService {
  /**
   * Progresses a deployment from PENDING to INSTALLING and then to BUILDING.
   * Also extends the deployment timeout.
   *
   * When progressing to BUILDING, the remote Depot build is also created.
   *
   * Only acts when the current status allows. Not idempotent.
   *
   * @param authenticatedEnv The environment which the deployment belongs to.
   * @param friendlyId The friendly deployment ID.
   * @param updates Optional deployment details to persist.
   */

  public progressDeployment(
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
      if (deployment.status !== "PENDING" && deployment.status !== "INSTALLING") {
        logger.warn(
          "Attempted progressing deployment that is not in PENDING or INSTALLING status",
          {
            deployment,
          }
        );
        return errAsync({ type: "deployment_cannot_be_progressed" as const });
      }

      return okAsync(deployment);
    };

    const progressToInstalling = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(
        this._prisma.workerDeployment.updateMany({
          where: { id: deployment.id, status: "PENDING" }, // status could've changed in the meantime, we're not locking the row
          data: {
            ...updates,
            status: "INSTALLING",
            startedAt: new Date(),
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((result) => {
        if (result.count === 0) {
          return errAsync({ type: "deployment_cannot_be_progressed" as const });
        }
        return okAsync({ id: deployment.id, status: "INSTALLING" as const });
      });

    const createRemoteBuild = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(createRemoteImageBuild(authenticatedEnv.project), (error) => ({
        type: "failed_to_create_remote_build" as const,
        cause: error,
      }));

    const progressToBuilding = (deployment: Pick<WorkerDeployment, "id">) =>
      createRemoteBuild(deployment)
        .andThen((externalBuildData) =>
          fromPromise(
            this._prisma.workerDeployment.updateMany({
              where: { id: deployment.id, status: "INSTALLING" }, // status could've changed in the meantime, we're not locking the row
              data: {
                ...updates,
                externalBuildData,
                status: "BUILDING",
                installedAt: new Date(),
              },
            }),
            (error) => ({
              type: "other" as const,
              cause: error,
            })
          )
        )
        .andThen((result) => {
          if (result.count === 0) {
            return errAsync({ type: "deployment_cannot_be_progressed" as const });
          }
          return okAsync({ id: deployment.id, status: "BUILDING" as const });
        });

    const extendTimeout = (deployment: Pick<WorkerDeployment, "id" | "status">) =>
      fromPromise(
        TimeoutDeploymentService.enqueue(
          deployment.id,
          deployment.status,
          deployment.status === "INSTALLING"
            ? "Installing dependencies timed out"
            : "Building timed out",
          new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
        ),
        (error) => ({
          type: "failed_to_extend_deployment_timeout" as const,
          cause: error,
        })
      );

    return getDeployment()
      .andThen(validateDeployment)
      .andThen((deployment) => {
        if (deployment.status === "PENDING") {
          return progressToInstalling(deployment);
        }
        return progressToBuilding(deployment);
      })
      .andThen(extendTimeout)
      .map(() => undefined);
  }

  /**
   * Cancels a deployment that is not yet in a final state.
   *
   * Only acts when the current status is not final. Not idempotent.
   *
   * @param authenticatedEnv The environment which the deployment belongs to.
   * @param friendlyId The friendly deployment ID.
   * @param data Cancelation reason.
   */
  public cancelDeployment(
    authenticatedEnv: Pick<AuthenticatedEnvironment, "projectId">,
    friendlyId: string,
    data?: Partial<Pick<WorkerDeployment, "canceledReason">>
  ) {
    const getDeployment = () =>
      fromPromise(
        this._prisma.workerDeployment.findFirst({
          where: {
            friendlyId,
            projectId: authenticatedEnv.projectId,
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
      if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
        logger.warn("Attempted cancelling deployment in a final state", {
          deployment,
        });
        return errAsync({ type: "deployment_cannot_be_cancelled" as const });
      }

      return okAsync(deployment);
    };

    const cancelDeployment = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(
        this._prisma.workerDeployment.updateMany({
          where: {
            id: deployment.id,
            status: {
              notIn: FINAL_DEPLOYMENT_STATUSES, // status could've changed in the meantime, we're not locking the row
            },
          },
          data: {
            status: "CANCELED",
            canceledAt: new Date(),
            canceledReason: data?.canceledReason,
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).andThen((result) => {
        if (result.count === 0) {
          return errAsync({ type: "deployment_cannot_be_cancelled" as const });
        }
        return okAsync({ id: deployment.id });
      });

    const deleteTimeout = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(TimeoutDeploymentService.dequeue(deployment.id, this._prisma), (error) => ({
        type: "failed_to_delete_deployment_timeout" as const,
        cause: error,
      }));

    return getDeployment()
      .andThen(validateDeployment)
      .andThen(cancelDeployment)
      .andThen(deleteTimeout)
      .map(() => undefined);
  }
}
