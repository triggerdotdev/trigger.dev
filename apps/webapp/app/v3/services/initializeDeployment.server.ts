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
    return this.traceWithEnv("call", environment, async (span) => {
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

      logger.debug("Creating deployment", {
        environmentId: environment.id,
        projectId: environment.projectId,
        version: nextVersion,
        triggeredById: triggeredBy?.id,
        type: payload.type,
        imageRef,
        isEcr,
        repoCreated,
      });

      const deployment = await this._prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: payload.contentHash,
          shortCode: deploymentShortCode,
          version: nextVersion,
          status: "BUILDING",
          environmentId: environment.id,
          projectId: environment.projectId,
          externalBuildData,
          triggeredById: triggeredBy?.id,
          type: payload.type,
          imageReference: imageRef,
          imagePlatform: env.DEPLOY_IMAGE_PLATFORM,
          git: payload.gitMeta ?? undefined,
          runtime: payload.runtime ?? undefined,
        },
      });

      await TimeoutDeploymentService.enqueue(
        deployment.id,
        "BUILDING",
        "Building timed out",
        new Date(Date.now() + env.DEPLOY_TIMEOUT_MS)
      );

      return {
        deployment,
        imageRef,
      };
    });
  }
}
