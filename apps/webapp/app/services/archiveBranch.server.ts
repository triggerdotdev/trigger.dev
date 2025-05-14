import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { checkBranchLimit } from "./upsertBranch.server";
import { logger } from "./logger.server";

export class ArchiveBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    userId: string,
    { action, environmentId }: { action: "archive" | "unarchive"; environmentId: string }
  ) {
    try {
      const environment = await this.#prismaClient.runtimeEnvironment.findFirstOrThrow({
        where: {
          id: environmentId,
          organization: {
            members: {
              some: {
                userId: userId,
              },
            },
          },
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

      if (action === "unarchive") {
        const limits = await checkBranchLimit(
          this.#prismaClient,
          environment.organization.id,
          environment.project.id
        );

        if (limits.isAtLimit) {
          return {
            success: false as const,
            error: `You've used all ${limits.used} of ${limits.limit} branches for your plan. Upgrade to get more branches or archive some.`,
          };
        }
      }

      const updatedBranch = await this.#prismaClient.runtimeEnvironment.update({
        where: { id: environmentId },
        data: { archivedAt: action === "archive" ? new Date() : null },
      });

      return {
        success: true as const,
        branch: updatedBranch,
        organization: environment.organization,
        project: environment.project,
      };
    } catch (e) {
      logger.error("ArchiveBranchService error", { environmentId, action, error: e });
      return {
        success: false as const,
        error: "Failed to archive branch",
      };
    }
  }
}
