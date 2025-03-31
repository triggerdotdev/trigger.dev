import { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { customAlphabet } from "nanoid";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";
import { WorkerDeploymentType } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";

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

      // Try and create a depot build and get back the external build data
      const externalBuildData = payload.selfHosted
        ? undefined
        : await createRemoteImageBuild(environment.project);

      const triggeredBy = payload.userId
        ? await this._prisma.user.findUnique({
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

      const sharedImageTag = `${payload.namespace ?? env.DEPLOY_REGISTRY_NAMESPACE}/${
        environment.project.externalRef
      }:${nextVersion}.${environment.slug}`;

      const unmanagedImageParts = [];

      if (payload.registryHost) {
        unmanagedImageParts.push(payload.registryHost);
      }
      if (payload.namespace) {
        unmanagedImageParts.push(payload.namespace);
      }
      unmanagedImageParts.push(
        `${environment.project.externalRef}:${nextVersion}.${environment.slug}`
      );

      const unmanagedImageTag = unmanagedImageParts.join("/");

      const isManaged = payload.type === WorkerDeploymentType.MANAGED;

      logger.debug("Creating deployment", {
        environmentId: environment.id,
        projectId: environment.projectId,
        version: nextVersion,
        triggeredById: triggeredBy?.id,
        type: payload.type,
        imageTag: isManaged ? sharedImageTag : unmanagedImageTag,
        imageReference: isManaged ? undefined : unmanagedImageTag,
      });

      const deployment = await this._prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: payload.contentHash,
          shortCode: nanoid(8),
          version: nextVersion,
          status: "BUILDING",
          environmentId: environment.id,
          projectId: environment.projectId,
          externalBuildData,
          triggeredById: triggeredBy?.id,
          type: payload.type,
          imageReference: isManaged ? undefined : unmanagedImageTag,
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
        imageTag: isManaged ? sharedImageTag : unmanagedImageTag,
      };
    });
  }
}
