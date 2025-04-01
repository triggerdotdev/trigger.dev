import { WorkerInstanceGroup, WorkerInstanceGroupType } from "@trigger.dev/database";
import { WithRunEngine } from "../baseService.server";
import { WorkerGroupTokenService } from "./workerGroupTokenService.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, makeFlags, makeSetFlags } from "~/v3/featureFlags.server";

export class WorkerGroupService extends WithRunEngine {
  private readonly defaultNamePrefix = "worker_group";

  async createWorkerGroup({
    projectId,
    organizationId,
    name,
    description,
  }: {
    projectId?: string;
    organizationId?: string;
    name?: string;
    description?: string;
  }) {
    if (!name) {
      name = await this.generateWorkerName({ projectId });
    }

    const tokenService = new WorkerGroupTokenService({
      prisma: this._prisma,
      engine: this._engine,
    });
    const token = await tokenService.createToken();

    const workerGroup = await this._prisma.workerInstanceGroup.create({
      data: {
        projectId,
        organizationId,
        type: projectId ? WorkerInstanceGroupType.UNMANAGED : WorkerInstanceGroupType.MANAGED,
        masterQueue: this.generateMasterQueueName({ projectId, name }),
        tokenId: token.id,
        description,
        name,
      },
    });

    if (workerGroup.type === WorkerInstanceGroupType.MANAGED) {
      const managedCount = await this._prisma.workerInstanceGroup.count({
        where: {
          type: WorkerInstanceGroupType.MANAGED,
        },
      });

      const getFlag = makeFlags(this._prisma);
      const defaultWorkerInstanceGroupId = await getFlag({
        key: FEATURE_FLAG.defaultWorkerInstanceGroupId,
      });

      // If there's no global default yet we should set it to the new worker group
      if (!defaultWorkerInstanceGroupId) {
        const setFlag = makeSetFlags(this._prisma);
        await setFlag({
          key: FEATURE_FLAG.defaultWorkerInstanceGroupId,
          value: workerGroup.id,
        });
      }
    }

    return {
      workerGroup,
      token,
    };
  }

  /**
    This updates a single worker group.
    The name should never be updated. This would mean changing the masterQueue name which can have unexpected consequences.
    */
  async updateWorkerGroup({
    projectId,
    workerGroupId,
    description,
  }: {
    projectId: string;
    workerGroupId: string;
    description?: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
        projectId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] No worker group found for update", {
        workerGroupId,
        description,
      });
      return;
    }

    await this._prisma.workerInstanceGroup.update({
      where: {
        id: workerGroup.id,
      },
      data: {
        description,
      },
    });
  }

  /**
    This lists worker groups.
    Without a project ID, only shared worker groups will be returned.
    With a project ID, in addition to all shared worker groups, ones associated with the project will also be returned.
    */
  async listWorkerGroups({ projectId, listHidden }: { projectId?: string; listHidden?: boolean }) {
    const workerGroups = await this._prisma.workerInstanceGroup.findMany({
      where: {
        OR: [
          {
            type: WorkerInstanceGroupType.MANAGED,
          },
          {
            projectId,
          },
        ],
        AND: listHidden ? [] : [{ hidden: false }],
      },
    });

    return workerGroups;
  }

  async deleteWorkerGroup({
    projectId,
    workerGroupId,
  }: {
    projectId: string;
    workerGroupId: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] WorkerGroup not found for deletion", {
        workerGroupId,
        projectId,
      });
      return;
    }

    if (workerGroup.projectId !== projectId) {
      logger.error("[WorkerGroupService] WorkerGroup does not belong to project", {
        workerGroupId,
        projectId,
      });
      return;
    }

    await this._prisma.workerInstanceGroup.delete({
      where: {
        id: workerGroupId,
      },
    });
  }

  async getGlobalDefaultWorkerGroup() {
    const flags = makeFlags(this._prisma);

    const defaultWorkerInstanceGroupId = await flags({
      key: FEATURE_FLAG.defaultWorkerInstanceGroupId,
    });

    if (!defaultWorkerInstanceGroupId) {
      logger.error("[WorkerGroupService] Default worker group not found in feature flags");
      return;
    }

    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: defaultWorkerInstanceGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] Default worker group not found", {
        defaultWorkerInstanceGroupId,
      });
      return;
    }

    return workerGroup;
  }

  async getDefaultWorkerGroupForProject({
    projectId,
  }: {
    projectId: string;
  }): Promise<WorkerInstanceGroup | undefined> {
    const project = await this._prisma.project.findUnique({
      where: {
        id: projectId,
      },
      include: {
        defaultWorkerGroup: true,
      },
    });

    if (!project) {
      logger.error("[WorkerGroupService] Project not found", { projectId });
      return;
    }

    if (project.defaultWorkerGroup) {
      return project.defaultWorkerGroup;
    }

    return await this.getGlobalDefaultWorkerGroup();
  }

  async setDefaultWorkerGroupForProject({
    projectId,
    workerGroupId,
  }: {
    projectId: string;
    workerGroupId: string;
  }) {
    const workerGroup = await this._prisma.workerInstanceGroup.findUnique({
      where: {
        id: workerGroupId,
      },
    });

    if (!workerGroup) {
      logger.error("[WorkerGroupService] WorkerGroup not found", {
        workerGroupId,
      });
      return;
    }

    await this._prisma.project.update({
      where: {
        id: projectId,
      },
      data: {
        defaultWorkerGroupId: workerGroupId,
      },
    });
  }

  private async generateWorkerName({ projectId }: { projectId?: string }) {
    const workerGroups = await this._prisma.workerInstanceGroup.count({
      where: {
        projectId: projectId ?? null,
      },
    });

    return `${this.defaultNamePrefix}_${workerGroups + 1}`;
  }

  private generateMasterQueueName({ projectId, name }: { projectId?: string; name: string }) {
    if (!projectId) {
      return name;
    }

    return `${projectId}-${name}`;
  }
}
