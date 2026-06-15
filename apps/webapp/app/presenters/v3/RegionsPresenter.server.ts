import { type WorkloadType } from "@trigger.dev/database";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { defaultVisibilityFilter, resolveComputeAccess } from "~/v3/regionAccess.server";
import { WorkerGroupService } from "~/v3/services/worker/workerGroupService.server";
import { BasePresenter } from "./basePresenter.server";
import { getCurrentPlan } from "~/services/platform.v3.server";

export type Region = {
  id: string;
  name: string;
  masterQueue: string;
  description?: string;
  cloudProvider?: string;
  location?: string;
  staticIPs?: string | null;
  isDefault: boolean;
  isHidden: boolean;
  workloadType: WorkloadType;
};

export class RegionsPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    environmentId,
    isAdmin = false,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    environmentId?: string;
    isAdmin?: boolean;
  }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
        organizationId: true,
        allowedWorkerQueues: true,
        organization: {
          select: { featureFlags: true },
        },
      },
      where: {
        slug: projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const environment = environmentId
      ? await this._replica.runtimeEnvironment.findFirst({
          select: { defaultWorkerGroupId: true },
          where: { id: environmentId, projectId: project.id, archivedAt: null },
        })
      : null;

    // Resolve via the same path the trigger uses (env -> project -> global, each
    // existence-checked) so the UI default always matches where runs route and can
    // never point at a deleted region.
    const defaultWorkerGroup = await new WorkerGroupService().getDefaultWorkerGroupForProject({
      projectId: project.id,
      environmentDefaultWorkerGroupId: environment?.defaultWorkerGroupId,
    });
    const effectiveDefaultId = defaultWorkerGroup?.id;

    const hasComputeAccess = await resolveComputeAccess(
      this._replica,
      project.organization.featureFlags
    );

    const visibleRegions = await this._replica.workerInstanceGroup.findMany({
      select: {
        id: true,
        name: true,
        masterQueue: true,
        description: true,
        cloudProvider: true,
        location: true,
        staticIPs: true,
        hidden: true,
        workloadType: true,
      },
      where: isAdmin
        ? undefined
        : // Hide hidden unless they're allowed to use them
        project.allowedWorkerQueues.length > 0
        ? {
            masterQueue: { in: project.allowedWorkerQueues },
          }
        : defaultVisibilityFilter(hasComputeAccess),
      orderBy: {
        name: "asc",
      },
    });

    const regions: Region[] = visibleRegions.map((region) => ({
      id: region.id,
      name: region.name,
      masterQueue: region.masterQueue,
      description: region.description ?? undefined,
      cloudProvider: region.cloudProvider ?? undefined,
      location: region.location ?? undefined,
      staticIPs: region.staticIPs ?? undefined,
      isDefault: region.id === effectiveDefaultId,
      isHidden: region.hidden,
      workloadType: region.workloadType,
    }));

    // The default may not be in the visible list (e.g. a hidden region set as the
    // env/project default) — include the already-resolved group so it still shows.
    if (defaultWorkerGroup && !regions.some((region) => region.id === defaultWorkerGroup.id)) {
      regions.push({
        id: defaultWorkerGroup.id,
        name: defaultWorkerGroup.name,
        masterQueue: defaultWorkerGroup.masterQueue,
        description: defaultWorkerGroup.description ?? undefined,
        cloudProvider: defaultWorkerGroup.cloudProvider ?? undefined,
        location: defaultWorkerGroup.location ?? undefined,
        staticIPs: defaultWorkerGroup.staticIPs ?? undefined,
        isDefault: true,
        isHidden: defaultWorkerGroup.hidden,
        workloadType: defaultWorkerGroup.workloadType,
      });
    }

    // Default first
    const sorted = regions.sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return a.name.localeCompare(b.name);
    });

    // Remove later duplicates
    let unique = sorted.filter((region, index, self) => {
      const firstIndex = self.findIndex((t) => t.id === region.id);
      return index === firstIndex;
    });

    // Don't show static IPs for free users
    // Even if they had the IPs they wouldn't work, but this makes it less confusing
    const currentPlan = await getCurrentPlan(project.organizationId);
    const isPaying = currentPlan?.v3Subscription.isPaying === true;
    if (!isPaying) {
      unique = unique.map((region) => ({
        ...region,
        staticIPs: region.staticIPs ? null : undefined,
      }));
    }

    return {
      regions: unique.sort((a, b) => a.name.localeCompare(b.name)),
      isPaying,
    };
  }
}
