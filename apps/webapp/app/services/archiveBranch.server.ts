import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";
import { nanoid } from "nanoid";

export class ArchiveBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(userId: string, { environmentId }: { environmentId: string }) {
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
