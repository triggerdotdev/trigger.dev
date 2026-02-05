import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { FEATURE_FLAG, makeFlag } from "~/v3/featureFlags.server";
import { BasePresenter } from "./basePresenter.server";
import { getCurrentPlan } from "~/services/platform.v3.server";

export type Region = {
  id: string;
  name: string;
  description?: string;
  cloudProvider?: string;
  location?: string;
  staticIPs?: string | null;
  isDefault: boolean;
  isHidden: boolean;
};

export class RegionsPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    isAdmin = false,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    isAdmin?: boolean;
  }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
        organizationId: true,
        defaultWorkerGroupId: true,
        allowedWorkerQueues: true,
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

    const getFlag = makeFlag(this._replica);
    const defaultWorkerInstanceGroupId = await getFlag({
      key: FEATURE_FLAG.defaultWorkerInstanceGroupId,
    });

    if (!defaultWorkerInstanceGroupId) {
      throw new Error("Default worker instance group not found");
    }

    const visibleRegions = await this._replica.workerInstanceGroup.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        cloudProvider: true,
        location: true,
        staticIPs: true,
        hidden: true,
      },
      where: isAdmin
        ? undefined
        : // Hide hidden unless they're allowed to use them
        project.allowedWorkerQueues.length > 0
        ? {
            masterQueue: { in: project.allowedWorkerQueues },
          }
        : {
            hidden: false,
          },
      orderBy: {
        name: "asc",
      },
    });

    const regions: Region[] = visibleRegions.map((region) => ({
      id: region.id,
      name: region.name,
      description: region.description ?? undefined,
      cloudProvider: region.cloudProvider ?? undefined,
      location: region.location ?? undefined,
      staticIPs: region.staticIPs ?? undefined,
      isDefault: region.id === defaultWorkerInstanceGroupId,
      isHidden: region.hidden,
    }));

    if (project.defaultWorkerGroupId) {
      const defaultWorkerGroup = await this._replica.workerInstanceGroup.findFirst({
        select: {
          id: true,
          name: true,
          description: true,
          cloudProvider: true,
          location: true,
          staticIPs: true,
          hidden: true,
        },
        where: { id: project.defaultWorkerGroupId },
      });

      if (defaultWorkerGroup) {
        // Unset the default region
        const defaultRegion = regions.find((region) => region.isDefault);
        if (defaultRegion) {
          defaultRegion.isDefault = false;
        }

        regions.push({
          id: defaultWorkerGroup.id,
          name: defaultWorkerGroup.name,
          description: defaultWorkerGroup.description ?? undefined,
          cloudProvider: defaultWorkerGroup.cloudProvider ?? undefined,
          location: defaultWorkerGroup.location ?? undefined,
          staticIPs: defaultWorkerGroup.staticIPs ?? undefined,
          isDefault: true,
          isHidden: defaultWorkerGroup.hidden,
        });
      }
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
