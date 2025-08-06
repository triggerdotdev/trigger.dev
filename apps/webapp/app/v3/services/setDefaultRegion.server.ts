import { BaseService, ServiceValidationError } from "./baseService.server";

export class SetDefaultRegionService extends BaseService {
  public async call({ projectId, regionId }: { projectId: string; regionId: string }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        id: regionId,
        hidden: false,
      },
    });

    if (!workerGroup) {
      throw new ServiceValidationError("Region not found or is hidden");
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
