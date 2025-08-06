import { BaseService, ServiceValidationError } from "./baseService.server";

export class SetDefaultRegionService extends BaseService {
  public async call({ projectId, regionId }: { projectId: string; regionId: string }) {
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
    });

    if (!project) {
      throw new ServiceValidationError("Project not found");
    }

    // If their project is restricted, only allow them to set default regions that are allowed
    if (project.allowedMasterQueues.length > 0) {
      if (!project.allowedMasterQueues.includes(workerGroup.masterQueue)) {
        throw new ServiceValidationError("You're not allowed to set this region as default");
      }
    } else if (workerGroup.hidden) {
      throw new ServiceValidationError("This region is not available to you");
    }

    await this._prisma.project.update({
      where: {
        id: projectId,
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
