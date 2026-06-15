import { isComputeRegionAccessible, resolveComputeAccess } from "~/v3/regionAccess.server";
import { BaseService, ServiceValidationError } from "./baseService.server";

export class SetDefaultRegionService extends BaseService {
  public async call({
    environmentId,
    regionId,
    isAdmin = false,
  }: {
    environmentId: string;
    regionId: string;
    isAdmin?: boolean;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        id: regionId,
      },
    });

    if (!workerGroup) {
      throw new ServiceValidationError("Region not found");
    }

    const environment = await this._prisma.runtimeEnvironment.findFirst({
      where: {
        id: environmentId,
      },
      select: {
        id: true,
        project: { select: { allowedWorkerQueues: true } },
        organization: { select: { featureFlags: true } },
      },
    });

    if (!environment) {
      throw new ServiceValidationError("Environment not found");
    }

    // The allowlist stays project-scoped; only the default moves to the environment.
    if (!isAdmin) {
      if (environment.project.allowedWorkerQueues.length > 0) {
        if (!environment.project.allowedWorkerQueues.includes(workerGroup.masterQueue)) {
          throw new ServiceValidationError("You're not allowed to set this region as default");
        }
      } else {
        if (workerGroup.hidden) {
          throw new ServiceValidationError("This region is not available to you");
        }

        if (workerGroup.workloadType === "MICROVM") {
          const hasComputeAccess = await resolveComputeAccess(
            this._prisma,
            environment.organization.featureFlags
          );

          if (!isComputeRegionAccessible(workerGroup, hasComputeAccess)) {
            throw new ServiceValidationError("This region requires compute access");
          }
        }
      }
    }

    await this._prisma.runtimeEnvironment.update({
      where: {
        id: environmentId,
      },
      data: {
        defaultWorkerGroupId: regionId,
      },
    });

    return {
      id: workerGroup.id,
      name: workerGroup.name,
    };
  }
}
