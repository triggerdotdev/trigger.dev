import { type InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { customAlphabet } from "nanoid";
import { env } from "~/env.server";
import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { createRemoteImageBuild, remoteBuildsEnabled } from "../remoteImageBuilder.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { getDeploymentImageRef } from "../getDeploymentImageRef.server";
import { tryCatch } from "@trigger.dev/core";
import { getRegistryConfig } from "../registryConfig.server";

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 8);

export class InitializeDeploymentService extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    payload: InitializeDeploymentRequestBody
  ) {
    return this.traceWithEnv("call", environment, async () => {
      if (payload.gitMeta?.commitSha?.startsWith("deployment_")) {
        // When we introduced automatic deployments via the build server, we slightly changed the deployment flow
        // mainly in the initialization and starting step: now deployments are first initialized in the `PENDING` status
        // and updated to `BUILDING` once the build server dequeues the build job.
        // Newer versions of the `deploy` command in the CLI will automatically attach to the existing deployment
        // and continue with the build process. For older versions, we can't change the command's client-side behavior,
        // so we need to handle this case here in the initialization endpoint. As we control the env variables which
        // the git meta is extracted from in the build server, we can use those to pass the existing deployment ID
        // to this endpoint. This doesn't affect the git meta on the deployment as it is set prior to this step using the
        // /start endpoint. It's a rather hacky solution, but it will do for now as it enables us to avoid degrading the
        // build server experience for users with older CLI versions. We'll eventually be able to remove this workaround
        // once we stop supporting 3.x CLI versions.

        const existingDeploymentId = payload.gitMeta.commitSha;
        const existingDeployment = await this._prisma.workerDeployment.findFirst({
          where: {
            environmentId: environment.id,
            friendlyId: existingDeploymentId,
          },
        });

        if (!existingDeployment) {
          throw new ServiceValidationError(
            "Existing deployment not found during deployment initialization"
          );
        }

        return {
          deployment: existingDeployment,
          imageRef: existingDeployment.imageReference ?? "",
        };
      }

      if (payload.type === "UNMANAGED") {
        throw new ServiceValidationError("UNMANAGED deployments are not supported");
      }

      // Upgrade the project to engine "V2" if it's not already. This should cover cases where people deploy to V2 without running dev first.
      if (payload.type === "MANAGED" && environment.project.engine === "V1") {
        await this._prisma.project.update({
          where: {
            id: environment.project.id,
          },
          data: {
            engine: "V2",
          },
        });
      }

      const latestDeployment = await this._prisma.workerDeployment.findFirst({
        where: {
          environmentId: environment.id,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      });

      const nextVersion = calculateNextBuildVersion(latestDeployment?.version);

      if (payload.selfHosted && remoteBuildsEnabled()) {
        throw new ServiceValidationError(
          "Self-hosted deployments are not supported on this instance"
        );
      }

      // Try and create a depot build and get back the external build data
      const externalBuildData = await createRemoteImageBuild(environment.project);

      const triggeredBy = payload.userId
        ? await this._prisma.user.findFirst({
            where: {
              id: payload.userId,
              orgMemberships: {
                some: {
                  organizationId: environment.project.organizationId,
                },
              },
            },
          })
        : undefined;

      const isV4Deployment = payload.type === "MANAGED";
      const registryConfig = getRegistryConfig(isV4Deployment);

      const deploymentShortCode = nanoid(8);

      const [imageRefError, imageRefResult] = await tryCatch(
        getDeploymentImageRef({
          registry: registryConfig,
          projectRef: environment.project.externalRef,
          nextVersion,
          environmentType: environment.type,
          deploymentShortCode,
        })
      );

      if (imageRefError) {
        logger.error("Failed to get deployment image ref", {
          environmentId: environment.id,
          projectId: environment.projectId,
          version: nextVersion,
          triggeredById: triggeredBy?.id,
          type: payload.type,
          cause: imageRefError.message,
        });
        throw new ServiceValidationError("Failed to get deployment image ref");
      }

      const { imageRef, isEcr, repoCreated } = imageRefResult;

      // we keep using `BUILDING` as the initial status if not explicitly set
      // to avoid changing the behavior for deployments not created in the build server
      const initialStatus = payload.initialStatus ?? "BUILDING";

      logger.debug("Creating deployment", {
        environmentId: environment.id,
        projectId: environment.projectId,
        version: nextVersion,
        triggeredById: triggeredBy?.id,
        type: payload.type,
        imageRef,
        isEcr,
        repoCreated,
        initialStatus,
      });

      const deployment = await this._prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: payload.contentHash,
          shortCode: deploymentShortCode,
          version: nextVersion,
          status: initialStatus,
          environmentId: environment.id,
          projectId: environment.projectId,
          externalBuildData,
          triggeredById: triggeredBy?.id,
          type: payload.type,
          imageReference: imageRef,
          imagePlatform: env.DEPLOY_IMAGE_PLATFORM,
          git: payload.gitMeta ?? undefined,
          runtime: payload.runtime ?? undefined,
          startedAt: initialStatus === "BUILDING" ? new Date() : undefined,
        },
      });

      const timeoutMs =
        deployment.status === "PENDING" ? env.DEPLOY_QUEUE_TIMEOUT_MS : env.DEPLOY_TIMEOUT_MS;

      await TimeoutDeploymentService.enqueue(
        deployment.id,
        deployment.status,
        "Building timed out",
        new Date(Date.now() + timeoutMs)
      );

      return {
        deployment,
        imageRef,
      };
    });
  }
}
