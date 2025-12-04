import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { errAsync, fromPromise, okAsync, type ResultAsync } from "neverthrow";
import { type WorkerDeployment, type Project } from "@trigger.dev/database";
import { logger, type GitMeta, type DeploymentEvent } from "@trigger.dev/core/v3";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";
import { FINAL_DEPLOYMENT_STATUSES } from "./failDeployment.server";
import { enqueueBuild, generateRegistryCredentials } from "~/services/platform.v3.server";
import { AppendRecord, S2 } from "@s2-dev/streamstore";
import { createRedisClient } from "~/redis.server";

const S2_TOKEN_KEY_PREFIX = "s2-token:read:deployment-event-stream:project:";
const s2TokenRedis = createRedisClient("s2-token-cache", {
  host: env.CACHE_REDIS_HOST,
  port: env.CACHE_REDIS_PORT,
  username: env.CACHE_REDIS_USERNAME,
  password: env.CACHE_REDIS_PASSWORD,
  tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
  clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
});
const s2 = env.S2_ENABLED === "1" ? new S2({ accessToken: env.S2_ACCESS_TOKEN }) : undefined;

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

    return this.getDeployment(authenticatedEnv.projectId, friendlyId)
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
    const validateDeployment = (
      deployment: Pick<WorkerDeployment, "id" | "status" | "shortCode"> & {
        environment: { project: { externalRef: string } };
      }
    ) => {
      if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
        logger.warn("Attempted cancelling deployment in a final state", {
          deployment,
        });
        return errAsync({ type: "deployment_cannot_be_cancelled" as const });
      }

      return okAsync(deployment);
    };

    const cancelDeployment = (
      deployment: Pick<WorkerDeployment, "id" | "shortCode"> & {
        environment: { project: { externalRef: string } };
      }
    ) =>
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
        return okAsync({ deployment });
      });

    const deleteTimeout = (deployment: Pick<WorkerDeployment, "id">) =>
      fromPromise(TimeoutDeploymentService.dequeue(deployment.id, this._prisma), (error) => ({
        type: "failed_to_delete_deployment_timeout" as const,
        cause: error,
      }));

    return this.getDeployment(authenticatedEnv.projectId, friendlyId)
      .andThen(validateDeployment)
      .andThen(cancelDeployment)
      .andThen(({ deployment }) =>
        this.appendToEventLog(deployment.environment.project, deployment, [
          {
            type: "finalized",
            data: {
              result: "canceled",
              message: data?.canceledReason ?? undefined,
            },
          },
        ])
          .orElse((error) => {
            logger.error("Failed to append event to deployment event log", { error });
            return okAsync(deployment);
          })
          .map(() => deployment)
      )
      .andThen(deleteTimeout)
      .map(() => undefined);
  }

  /**
   * Generates registry credentials for a deployment. Returns an error if the deployment is in a final state.
   *
   * Uses the `platform` package, only available in cloud.
   *
   * @param authenticatedEnv The environment which the deployment belongs to.
   * @param friendlyId The friendly deployment ID.
   */
  public generateRegistryCredentials(
    authenticatedEnv: Pick<AuthenticatedEnvironment, "projectId">,
    friendlyId: string
  ) {
    const validateDeployment = (
      deployment: Pick<WorkerDeployment, "id" | "status" | "imageReference">
    ) => {
      if (FINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
        return errAsync({ type: "deployment_is_already_final" as const });
      }
      return okAsync(deployment);
    };

    const getDeploymentRegion = (deployment: Pick<WorkerDeployment, "imageReference">) => {
      if (!deployment.imageReference) {
        return errAsync({ type: "deployment_has_no_image_reference" as const });
      }
      if (!deployment.imageReference.includes("amazonaws.com")) {
        return errAsync({ type: "registry_not_supported" as const });
      }

      // we should connect the deployment to a region more explicitly in the future
      // for now we just use the image reference to determine the region
      if (deployment.imageReference.includes("us-east-1")) {
        return okAsync({ region: "us-east-1" as const });
      }
      if (deployment.imageReference.includes("eu-central-1")) {
        return okAsync({ region: "eu-central-1" as const });
      }

      return errAsync({ type: "registry_region_not_supported" as const });
    };

    const generateCredentials = ({ region }: { region: "us-east-1" | "eu-central-1" }) =>
      fromPromise(generateRegistryCredentials(authenticatedEnv.projectId, region), (error) => ({
        type: "other" as const,
        cause: error,
      })).andThen((result) => {
        if (!result || !result.success) {
          return errAsync({ type: "missing_registry_credentials" as const });
        }
        return okAsync({
          username: result.username,
          password: result.password,
          expiresAt: new Date(result.expiresAt),
          repositoryUri: result.repositoryUri,
        });
      });

    return this.getDeployment(authenticatedEnv.projectId, friendlyId)
      .andThen(validateDeployment)
      .andThen(getDeploymentRegion)
      .andThen(generateCredentials);
  }

  public enqueueBuild(
    authenticatedEnv: Pick<AuthenticatedEnvironment, "projectId">,
    deployment: Pick<WorkerDeployment, "friendlyId">,
    artifactKey: string,
    options: {
      skipPromotion?: boolean;
      configFilePath?: string;
    }
  ) {
    return fromPromise(
      enqueueBuild(authenticatedEnv.projectId, deployment.friendlyId, artifactKey, options),
      (error) => ({
        type: "failed_to_enqueue_build" as const,
        cause: error,
      })
    );
  }

  public appendToEventLog(
    project: Pick<Project, "externalRef">,
    deployment: Pick<WorkerDeployment, "shortCode">,
    events: DeploymentEvent[]
  ): ResultAsync<
    undefined,
    { type: "s2_is_disabled" } | { type: "failed_to_append_to_event_log"; cause: unknown }
  > {
    if (env.S2_ENABLED !== "1" || !s2) {
      return errAsync({ type: "s2_is_disabled" as const });
    }

    const basin = s2.basin(env.S2_DEPLOYMENT_LOGS_BASIN_NAME);
    const stream = basin.stream(
      `projects/${project.externalRef}/deployments/${deployment.shortCode}`
    );

    return fromPromise(
      stream.append(events.map((event) => AppendRecord.make(JSON.stringify(event)))),
      (error) => ({
        type: "failed_to_append_to_event_log" as const,
        cause: error,
      })
    ).map(() => undefined);
  }

  public createEventStream(
    project: Pick<Project, "externalRef">,
    deployment: Pick<WorkerDeployment, "shortCode">
  ): ResultAsync<
    { basin: string; stream: string },
    { type: "s2_is_disabled" } | { type: "failed_to_create_event_stream"; cause: unknown }
  > {
    if (env.S2_ENABLED !== "1" || !s2) {
      return errAsync({ type: "s2_is_disabled" as const });
    }
    const basin = s2.basin(env.S2_DEPLOYMENT_LOGS_BASIN_NAME);

    return fromPromise(
      basin.streams.create({
        stream: `projects/${project.externalRef}/deployments/${deployment.shortCode}`,
      }),
      (error) => ({
        type: "failed_to_create_event_stream" as const,
        cause: error,
      })
    ).map(({ name }) => ({
      basin: basin.name,
      stream: name,
    }));
  }

  public getEventStreamAccessToken(
    project: Pick<Project, "externalRef">
  ): ResultAsync<string, { type: "s2_is_disabled" } | { type: "other"; cause: unknown }> {
    if (env.S2_ENABLED !== "1" || !s2) {
      return errAsync({ type: "s2_is_disabled" as const });
    }
    const basinName = env.S2_DEPLOYMENT_LOGS_BASIN_NAME;
    const redisKey = `${S2_TOKEN_KEY_PREFIX}${project.externalRef}`;

    const getTokenFromCache = () =>
      fromPromise(s2TokenRedis.get(redisKey), (error) => ({
        type: "other" as const,
        cause: error,
      })).andThen((cachedToken) => {
        if (!cachedToken) {
          return errAsync({ type: "s2_token_cache_not_found" as const });
        }
        return okAsync(cachedToken);
      });

    const issueS2Token = () =>
      fromPromise(
        s2.accessTokens.issue({
          id: `${project.externalRef}-${new Date().getTime()}`,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
          scope: {
            ops: ["read"],
            basins: {
              exact: basinName,
            },
            streams: {
              prefix: `projects/${project.externalRef}/deployments/`,
            },
          },
        }),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      ).map(({ access_token }) => access_token);

    const cacheToken = (token: string) =>
      fromPromise(
        s2TokenRedis.setex(
          redisKey,
          59 * 60, // slightly shorter than the token validity period
          token
        ),
        (error) => ({
          type: "other" as const,
          cause: error,
        })
      );

    return getTokenFromCache().orElse(() =>
      issueS2Token().andThen((token) =>
        cacheToken(token)
          .map(() => token)
          .orElse((error) => {
            logger.error("Failed to cache S2 token", { error });
            return okAsync(token); // ignore the cache error
          })
      )
    );
  }

  private getDeployment(projectId: string, friendlyId: string) {
    return fromPromise(
      this._prisma.workerDeployment.findFirst({
        where: {
          friendlyId,
          projectId,
        },
        select: {
          status: true,
          id: true,
          imageReference: true,
          shortCode: true,
          environment: {
            include: {
              project: {
                select: {
                  externalRef: true,
                },
              },
            },
          },
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
  }
}
