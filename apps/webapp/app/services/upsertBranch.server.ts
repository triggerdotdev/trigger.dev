import { type PrismaClient, type PrismaClientOrTransaction } from "@trigger.dev/database";
import slug from "slug";
import { prisma } from "~/db.server";
import { createApiKeyForEnv, createPkApiKeyForEnv } from "~/models/api-key.server";
import { logger } from "./logger.server";
import { getLimit } from "./platform.v3.server";
import { type CreateBranchOptions } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route";

export class UpsertBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(userId: string, { parentEnvironmentId, branchName, git }: CreateBranchOptions) {
    const sanitizedBranchName = branchNameFromRef(branchName);
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
      const parentEnvironment = await this.#prismaClient.runtimeEnvironment.findFirstOrThrow({
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

      if (!parentEnvironment.isBranchableEnvironment) {
        return {
          success: false as const,
          error: "Parent environment is not branchable",
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

      const branch = await prisma.runtimeEnvironment.upsert({
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
        error: "Failed to create branch",
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

export function isValidGitBranchName(branch: string): boolean {
  // Must not be empty
  if (!branch) return false;

  // Disallowed characters: space, ~, ^, :, ?, *, [, \
  if (/[ \~\^:\?\*\[\\]/.test(branch)) return false;

  // Disallow ASCII control characters (0-31) and DEL (127)
  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return false;
  }

  // Cannot start or end with a slash
  if (branch.startsWith("/") || branch.endsWith("/")) return false;

  // Cannot have consecutive slashes
  if (branch.includes("//")) return false;

  // Cannot contain '..'
  if (branch.includes("..")) return false;

  // Cannot contain '@{'
  if (branch.includes("@{")) return false;

  // Cannot end with '.lock'
  if (branch.endsWith(".lock")) return false;

  return true;
}

export function branchNameFromRef(ref: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("refs/heads/")) return ref.substring("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.substring("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.substring("refs/tags/".length);
  if (ref.startsWith("refs/pull/")) return ref.substring("refs/pull/".length);
  if (ref.startsWith("refs/merge/")) return ref.substring("refs/merge/".length);
  if (ref.startsWith("refs/release/")) return ref.substring("refs/release/".length);
  //unknown ref format, so reject
  if (ref.startsWith("refs/")) return null;

  return ref;
}
