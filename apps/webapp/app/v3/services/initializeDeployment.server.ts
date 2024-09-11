import { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { customAlphabet } from "nanoid";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { BaseService } from "./baseService.server";
import { TimeoutDeploymentService } from "./timeoutDeployment.server";
import { env } from "~/env.server";

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 8);

export class InitializeDeploymentService extends BaseService {
  public async call(
    environment: AuthenticatedEnvironment,
    payload: InitializeDeploymentRequestBody
  ) {
    return this.traceWithEnv("call", environment, async (span) => {
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
      const externalBuildData = !!payload.selfHosted
        ? await createRemoteImageBuild(environment.project)
        : undefined;

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
        },
      });

      await TimeoutDeploymentService.enqueue(
        deployment.id,
        "BUILDING",
        "Building timed out",
        new Date(Date.now() + 180_000) // 3 minutes
      );

      const imageTag = `${payload.namespace ?? env.DEPLOY_REGISTRY_NAMESPACE}/${
        environment.project.externalRef
      }:${deployment.version}.${environment.slug}`;

      return { deployment, imageTag };
    });
  }
}
