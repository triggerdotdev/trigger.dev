import { type z } from "zod";
import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { FEATURE_FLAG, flags, makeFlags } from "~/v3/featureFlags.server";
import { BasePresenter } from "./basePresenter.server";

export type Region = {
  id: string;
  name: string;
  description?: string;
  cloudProvider?: string;
  location?: string;
  staticIPs?: string;
  isDefault: boolean;
};

export class RegionsPresenter extends BasePresenter {
  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
        organizationId: true,
        defaultWorkerGroupId: true,
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

    const getFlag = makeFlags(this._replica);
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
      },
      where: {
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
    const unique = sorted.filter((region, index, self) => {
      const firstIndex = self.findIndex((t) => t.id === region.id);
      return index === firstIndex;
    });

    return {
      regions: unique.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
