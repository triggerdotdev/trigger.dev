import { isComputeRegionAccessible, resolveComputeAccess } from "~/v3/regionAccess.server";
import { BaseService, ServiceValidationError } from "./baseService.server";

export const DEFAULT_REGION_CHANGED = "The project's default region changed in the meantime.";

export class SetDefaultRegionService extends BaseService {
  public async call({
    projectId,
    regionId,
    isAdmin = false,
    expectedDefaultRegionId,
  }: {
    projectId: string;
    regionId: string;
    isAdmin?: boolean;
    /** When set, changes the default only if this is still the stored one (null: none). */
    expectedDefaultRegionId?: string | null;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        id: regionId,
      },
    });

    if (!workerGroup) {
      throw new ServiceValidationError("Region not found");
    }

    const project = await this._prisma.project.findFirst({
      where: {
        id: projectId,
      },
      include: {
        organization: { select: { featureFlags: true } },
      },
    });

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    // If their project is restricted, only allow them to set default regions that are allowed
    if (!isAdmin) {
      if (project.allowedWorkerQueues.length > 0) {
        if (!project.allowedWorkerQueues.includes(workerGroup.masterQueue)) {
          throw new ServiceValidationError("You're not allowed to set this region as default");
        }
      } else {
        if (workerGroup.hidden) {
          throw new ServiceValidationError("This region is not available to you");
        }

        if (workerGroup.workloadType === "MICROVM") {
          const hasComputeAccess = await resolveComputeAccess(
            this._prisma,
            project.organization.featureFlags
          );

          if (!isComputeRegionAccessible(workerGroup, hasComputeAccess)) {
            throw new ServiceValidationError("This region requires compute access");
          }
        }
      }
    }

    if (expectedDefaultRegionId === undefined) {
      await this._prisma.project.update({
        where: {
          id: projectId,
        },
        data: {
          defaultWorkerGroupId: regionId,
        },
      });
    } else {
      const written = await this._prisma.project.updateMany({
        where: { id: projectId, defaultWorkerGroupId: expectedDefaultRegionId },
        data: { defaultWorkerGroupId: regionId },
      });
      if (written.count === 0) throw new ServiceValidationError(DEFAULT_REGION_CHANGED);
    }

    return {
      id: workerGroup.id,
      name: workerGroup.name,
    };
  }
}
