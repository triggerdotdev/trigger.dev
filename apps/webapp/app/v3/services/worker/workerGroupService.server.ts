import type { Prisma, WorkerInstanceGroup, WorkloadType } from "@trigger.dev/database";
import { WorkerInstanceGroupType } from "@trigger.dev/database";
import { WithRunEngine } from "../baseService.server";
import { isWorkerGroupAllowedForProject } from "./workerGroupAccess";
import { WorkerGroupTokenService } from "./workerGroupTokenService.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag, makeSetFlag } from "~/v3/featureFlags.server";
import { isComputeRegionAccessible, resolveComputeAccess } from "~/v3/regionAccess.server";

/**
 * Thrown when a per-trigger `region` override names a region outside the task
 * definition's allowlist. Callers map this to a 400 (caller input) error.
 */
export class RegionNotAllowedForTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionNotAllowedForTaskError";
  }
}

type ProjectForRegionResolution = Prisma.ProjectGetPayload<{
  include: { defaultWorkerGroup: true; organization: { select: { featureFlags: true } } };
}>;

export class WorkerGroupService extends WithRunEngine {
  private readonly defaultNamePrefix = "worker_group";

  async createWorkerGroup({
    projectId,
    organizationId,
    name,
    description,
    type,
    hidden,
    workloadType,
    cloudProvider,
    location,
    staticIPs,
    enableFastPath,
  }: {
    projectId?: string;
    organizationId?: string;
    name?: string;
    description?: string;
    type?: WorkerInstanceGroupType;
    hidden?: boolean;
    workloadType?: WorkloadType;
    cloudProvider?: string;
    location?: string;
    staticIPs?: string;
    enableFastPath?: boolean;
  }) {
    if (!name) {
      name = await this.generateWorkerName({ projectId });
    }

    const tokenService = new WorkerGroupTokenService({
      prisma: this._prisma,
      engine: this._engine,
    });
    const token = await tokenService.createToken();

    const resolvedType =
      type ?? (projectId ? WorkerInstanceGroupType.UNMANAGED : WorkerInstanceGroupType.MANAGED);

    const workerGroup = await this._prisma.workerInstanceGroup.create({
      data: {
        projectId,
        organizationId,
        type: resolvedType,
        masterQueue: this.generateMasterQueueName({ projectId, name }),
        tokenId: token.id,
        description,
        name,
        hidden,
        workloadType,
        cloudProvider,
        location,
        staticIPs,
        enableFastPath,
      },
    });

    if (workerGroup.type === WorkerInstanceGroupType.MANAGED) {
      const _managedCount = await this._prisma.workerInstanceGroup.count({
        where: {
          type: WorkerInstanceGroupType.MANAGED,
        },
      });

      const getFlag = makeFlag(this._prisma);
      const defaultWorkerInstanceGroupId = await getFlag({
        key: FEATURE_FLAG.defaultWorkerInstanceGroupId,
      });

      // If there's no global default yet we should set it to the new worker group
      if (!defaultWorkerInstanceGroupId) {
        const setFlag = makeSetFlag(this._prisma);
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
    const flags = makeFlag(this._prisma);

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

  /**
   * Resolves the worker group (region) a run should be placed in.
   *
   * - `regionOverride` (the per-trigger `region` option) wins, subject to access
   *   checks. When the task definition lists `allowedRegions`, the override must be
   *   one of them or a `RegionNotAllowedForTaskError` is thrown.
   * - Otherwise, with `allowedRegions`: the effective default (project default, else
   *   global default) when it is in the list, else the first listed region, subject
   *   to the same access checks as an override.
   * - Otherwise the effective default.
   */
  async getDefaultWorkerGroupForProject({
    projectId,
    regionOverride,
    allowedRegions,
    taskId,
  }: {
    projectId: string;
    regionOverride?: string;
    /** Regions the task definition allows. Empty/undefined = unconstrained. */
    allowedRegions?: string[];
    /** Task identifier, used only in error messages. */
    taskId?: string;
  }): Promise<WorkerInstanceGroup | undefined> {
    const project = await this._prisma.project.findFirst({
      where: {
        id: projectId,
      },
      include: {
        defaultWorkerGroup: true,
        organization: { select: { featureFlags: true } },
      },
    });

    if (!project) {
      throw new Error("Project not found.");
    }

    const allowlist = allowedRegions && allowedRegions.length > 0 ? allowedRegions : undefined;

    // If they've specified a region, we need to check they have access to it
    if (regionOverride) {
      if (allowlist && !allowlist.includes(regionOverride)) {
        throw new RegionNotAllowedForTaskError(
          `Task "${taskId ?? "unknown"}" can only run in: ${allowlist.join(
            ", "
          )}. You specified "${regionOverride}".`
        );
      }

      return await this.#resolveAccessibleWorkerGroup(project, regionOverride, {
        source: "override",
      });
    }

    if (allowlist) {
      // Prefer the effective default when the task allows it (no extra query when
      // the project has an explicit default), otherwise the first region the task
      // lists, which goes through the same access checks as an override would.
      const effectiveDefault =
        project.defaultWorkerGroup ?? (await this.getGlobalDefaultWorkerGroup());

      if (effectiveDefault && allowlist.includes(effectiveDefault.masterQueue)) {
        return effectiveDefault;
      }

      return await this.#resolveAccessibleWorkerGroup(project, allowlist[0], {
        source: "task",
        taskId,
      });
    }

    if (project.defaultWorkerGroup) {
      return project.defaultWorkerGroup;
    }

    return await this.getGlobalDefaultWorkerGroup();
  }

  /**
   * Looks up a worker group by master queue and applies every access check a
   * per-trigger region override gets: existence, cross-project UNMANAGED groups,
   * the project's allowed-queue list, hidden groups and MICROVM compute access.
   */
  async #resolveAccessibleWorkerGroup(
    project: ProjectForRegionResolution,
    masterQueue: string,
    { source, taskId }: { source: "override" | "task"; taskId?: string }
  ): Promise<WorkerInstanceGroup> {
    const label =
      source === "task"
        ? `The region configured on task "${taskId ?? "unknown"}"`
        : "The region you specified";

    const workerGroup = await this._prisma.workerInstanceGroup.findFirst({
      where: {
        masterQueue,
      },
    });

    if (!workerGroup) {
      throw new Error(`${label} doesn't exist ("${masterQueue}").`);
    }

    // The masterQueue-only lookup above can resolve another project's
    // UNMANAGED group, so reject groups not usable by this project
    // (see isWorkerGroupAllowedForProject).
    if (!isWorkerGroupAllowedForProject(workerGroup, project.id)) {
      throw new Error(`${label} isn't available to you ("${masterQueue}").`);
    }

    // If they're restricted, check they have access
    if (project.allowedWorkerQueues.length > 0) {
      if (project.allowedWorkerQueues.includes(workerGroup.masterQueue)) {
        return workerGroup;
      }

      throw new Error(
        `You don't have access to this region ("${masterQueue}"). You can use the following regions: ${project.allowedWorkerQueues.join(
          ", "
        )}.`
      );
    }

    if (workerGroup.hidden) {
      throw new Error(`${label} isn't available to you ("${masterQueue}").`);
    }

    if (workerGroup.workloadType === "MICROVM") {
      const hasComputeAccess = await resolveComputeAccess(
        this._prisma,
        project.organization.featureFlags
      );

      if (!isComputeRegionAccessible(workerGroup, hasComputeAccess)) {
        throw new Error(`${label} isn't available to you ("${masterQueue}").`);
      }
    }

    return workerGroup;
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
