import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { customAlphabet } from "nanoid";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";
import { InitializeDeploymentRequestBody } from "@trigger.dev/core/v3";

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
      const externalBuildData = await createRemoteImageBuild();

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
        },
      });

      const imageTag = `trigger/${environment.project.externalRef}:${deployment.version}.${environment.slug}`;

      return { deployment, imageTag };
    });
  }
}
