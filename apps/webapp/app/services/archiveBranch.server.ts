import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { nanoid } from "nanoid";

export class ArchiveBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    // The orgFilter approach is not ideal but we need to keep it this way for now because of how the service is used in routes and api endpoints.
    // Currently authorization checks are spread across the controller/route layer and the service layer. Often we check in multiple places for org/project membership.
    // Ideally we would take care of both the authentication and authorization checks in the controllers and routes.
    // That would unify how we handle authorization and org/project membership checks. Also it would make the service layer queries simpler.
    orgFilter:
      | { type: "userMembership"; userId: string }
      | { type: "orgId"; organizationId: string },
    {
      environmentId,
    }: {
      environmentId: string;
    }
  ) {
    try {
      const environment = await this.#prismaClient.runtimeEnvironment.findFirstOrThrow({
        where: {
          id: environmentId,
          organization:
            orgFilter.type === "userMembership"
              ? {
                  members: {
                    some: {
                      userId: orgFilter.userId,
                    },
                  },
                }
              : { id: orgFilter.organizationId },
        },
        include: {
          organization: {
            select: {
              id: true,
              slug: true,
              maximumConcurrencyLimit: true,
            },
          },
          project: {
            select: {
              id: true,
              slug: true,
            },
          },
        },
      });

      if (!environment.parentEnvironmentId) {
        return {
          success: false as const,
          error: "This isn't a branch, and cannot be archived.",
        };
      }

      const slug = `${environment.slug}-${nanoid(6)}`;
      const shortcode = slug;

      const updatedBranch = await this.#prismaClient.runtimeEnvironment.update({
        where: { id: environmentId },
        data: { archivedAt: new Date(), slug, shortcode },
      });

      return {
        success: true as const,
        branch: updatedBranch,
        organization: environment.organization,
        project: environment.project,
      };
    } catch (e) {
      logger.error("ArchiveBranchService error", { environmentId, error: e });
      return {
        success: false as const,
        error: "Failed to archive branch",
      };
    }
  }
}
