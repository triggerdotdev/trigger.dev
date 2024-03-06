import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { BaseService } from "./baseService.server";
import { calculateNextBuildVersion } from "../utils/calculateNextBuildVersion";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { customAlphabet } from "nanoid";
import { createRemoteImageBuild } from "../remoteImageBuilder.server";

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 8);

export class InitializeDeploymentService extends BaseService {
  public async call(environment: AuthenticatedEnvironment) {
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
          shortCode: nanoid(8),
          version: nextVersion,
          status: "PENDING",
          environmentId: environment.id,
          projectId: environment.projectId,
          externalBuildData,
        },
      });

      return deployment;
    });
  }
}
