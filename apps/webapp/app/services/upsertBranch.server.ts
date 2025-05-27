import { type PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import slug from "slug";
import { prisma } from "~/db.server";
import { createApiKeyForEnv, createPkApiKeyForEnv } from "~/models/api-key.server";
import { type CreateBranchOptions } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route";
import { isValidGitBranchName, sanitizeBranchName } from "~/v3/gitBranch";
import { logger } from "./logger.server";
import { getLimit } from "./platform.v3.server";

export class UpsertBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(userId: string, { parentEnvironmentId, branchName, git }: CreateBranchOptions) {
    const sanitizedBranchName = sanitizeBranchName(branchName);
    if (!sanitizedBranchName) {
      return {
        success: false as const,
        error: "Branch name has an invalid format",
      };
    }

    if (!isValidGitBranchName(sanitizedBranchName)) {
      return {
        success: false as const,
        error: "Invalid branch name, contains disallowed character sequences",
      };
    }

    try {
      const parentEnvironment = await this.#prismaClient.runtimeEnvironment.findFirst({
        where: {
          id: parentEnvironmentId,
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

      if (!parentEnvironment) {
        return {
          success: false as const,
          error: "You don't have preview branches setup. Go to the dashboard to enable them.",
        };
      }

      if (!parentEnvironment.isBranchableEnvironment) {
        return {
          success: false as const,
          error: "Your preview environment is not branchable",
        };
      }

      const limits = await checkBranchLimit(
        this.#prismaClient,
        parentEnvironment.organization.id,
        parentEnvironment.project.id
      );

      if (limits.isAtLimit) {
        return {
          success: false as const,
          error: `You've used all ${limits.used} of ${limits.limit} branches for your plan. Upgrade to get more branches or archive some.`,
        };
      }

      const branchSlug = `${slug(`${parentEnvironment.slug}-${sanitizedBranchName}`)}`;
      const apiKey = createApiKeyForEnv(parentEnvironment.type);
      const pkApiKey = createPkApiKeyForEnv(parentEnvironment.type);
      const shortcode = branchSlug;

      const now = new Date();

      const branch = await this.#prismaClient.runtimeEnvironment.upsert({
        where: {
          projectId_shortcode: {
            projectId: parentEnvironment.project.id,
            shortcode: shortcode,
          },
        },
        create: {
          slug: branchSlug,
          apiKey,
          pkApiKey,
          shortcode,
          maximumConcurrencyLimit: parentEnvironment.maximumConcurrencyLimit,
          organization: {
            connect: {
              id: parentEnvironment.organization.id,
            },
          },
          project: {
            connect: { id: parentEnvironment.project.id },
          },
          branchName: sanitizedBranchName,
          type: parentEnvironment.type,
          parentEnvironment: {
            connect: { id: parentEnvironment.id },
          },
          git: git ?? undefined,
        },
        update: {
          git: git ?? undefined,
        },
      });

      const alreadyExisted = branch.createdAt < now;

      return {
        success: true as const,
        alreadyExisted: alreadyExisted,
        branch,
        organization: parentEnvironment.organization,
        project: parentEnvironment.project,
      };
    } catch (e) {
      logger.error("CreateBranchService error", { error: e });
      return {
        success: false as const,
        error: e instanceof Error ? e.message : "Failed to create branch",
      };
    }
  }
}

export async function checkBranchLimit(
  prisma: PrismaClientOrTransaction,
  organizationId: string,
  projectId: string
) {
  const used = await prisma.runtimeEnvironment.count({
    where: {
      projectId,
      branchName: {
        not: null,
      },
      archivedAt: null,
    },
  });
  const limit = await getLimit(organizationId, "branches", 50);

  return {
    used,
    limit,
    isAtLimit: used >= limit,
  };
}
