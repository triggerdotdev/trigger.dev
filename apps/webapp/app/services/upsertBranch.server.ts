import {
  type Prisma,
  type PrismaClient,
  type PrismaClientOrTransaction,
} from "@trigger.dev/database";
import slug from "slug";
import { prisma } from "~/db.server";
import { createApiKeyForEnv, createPkApiKeyForEnv } from "~/models/api-key.server";
import { isValidGitBranchName, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import {
  type BranchableEnvironmentType,
  isBranchableEnvironment,
  rootEnvironmentWhere,
  toBranchableEnvironmentType,
} from "~/utils/branchableEnvironment";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { ArchiveBranchService } from "./archiveBranch.server";
import { logger } from "./logger.server";
import { getCurrentPlan, getLimit } from "./platform.v3.server";
import { type z } from "zod";
import invariant from "tiny-invariant";
import { type CreateBranchOptions } from "~/utils/branches";
import {
  applyBillingLimitPauseAfterEnvCreate,
  getInitialEnvPauseStateForBillingLimit,
} from "~/v3/services/billingLimit/getInitialEnvPauseStateForBillingLimit.server";

type CreateBranchOptions = z.infer<typeof CreateBranchOptions>;
type OrgFilter =
  | { type: "userMembership"; userId: string }
  | { type: "orgId"; organizationId: string };

const DEV_BRANCH_STALE_AFTER_MS = 60 * 60 * 1000;
const DEV_BRANCH_AUTO_ARCHIVE_LIMIT = 3;

export class UpsertBranchService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    // The orgFilter approach is not ideal but we need to keep it this way for now because of how the service is used in routes and api endpoints.
    // Currently authorization checks are spread across the controller/route layer and the service layer. Often we check in multiple places for org/project membership.
    // Ideally we would take care of both the authentication and authorization checks in the controllers and routes.
    // That would unify how we handle authorization and org/project membership checks. Also it would make the service layer queries simpler.
    orgFilter: OrgFilter,
    { projectId, env, branchName, git }: CreateBranchOptions
  ) {
    const parentEnvType = toBranchableEnvironmentType(env);
    // Dev branch creation is always user-scoped (org tokens are rejected upstream),
    // so we can disambiguate the per-member dev root by userId.
    const userId = orgFilter.type === "userMembership" ? orgFilter.userId : undefined;

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
          projectId,
          // Locate the branchable parent structurally (root env of this type),
          // not by its magic slug. Branchability is asserted below.
          ...rootEnvironmentWhere(parentEnvType, { userId }),
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

      // Dev environments are scoped per org member, so a dev branch must inherit
      // its parent's orgMemberId. Preview parents have no orgMember (orgMemberId is null).
      if (!parentEnvironment) {
        // This should never happen
        if (env === "development") {
          return {
            success: false as const,
            error: "Error: No default dev runtime environment setup.",
          };
        }
        return {
          success: false as const,
          error: "You don't have preview branches setup. Go to the dashboard to enable them.",
        };
      }

      if (!isBranchableEnvironment(parentEnvironment)) {
        return {
          success: false as const,
          error: `Your ${env} environment is not branchable`,
        };
      }

      let limits = await checkBranchLimit({
        prisma: this.#prismaClient,
        organizationId: parentEnvironment.organization.id,
        projectId: parentEnvironment.project.id,
        type: parentEnvType,
        userId,
        newBranchName: sanitizedBranchName,
      });
      const autoArchivedBranches = limits.isAtLimit
        ? await autoArchiveStaleDevBranches({
            prisma: this.#prismaClient,
            orgFilter,
            parentEnvironment,
            userId,
            limit: limits.limit,
          })
        : [];

      if (autoArchivedBranches.length > 0) {
        limits = await checkBranchLimit({
          prisma: this.#prismaClient,
          organizationId: parentEnvironment.organization.id,
          projectId: parentEnvironment.project.id,
          type: parentEnvType,
          userId,
          newBranchName: sanitizedBranchName,
        });
      }

      if (limits.isAtLimit) {
        // DEVELOPMENT has no upgrade path, so only PREVIEW mentions upgrading.
        const remediation =
          parentEnvType === "PREVIEW"
            ? "Use the CLI to view your existing branches and archive any you no longer need, or upgrade to get more."
            : "Use the CLI to view your existing branches and archive any you no longer need.";

        return {
          success: false as const,
          error: `You've used all ${limits.used} of ${limits.limit} branches for your plan. ${remediation}`,
        };
      }

      const branchSlug = `${slug(`${parentEnvironment.slug}-${sanitizedBranchName}`)}`;
      const apiKey = createApiKeyForEnv(parentEnvironment.type);
      const pkApiKey = createPkApiKeyForEnv(parentEnvironment.type);
      const isDevelopmentBranch = parentEnvironment.type === "DEVELOPMENT";
      // Dev branches can share a slug across members, so their identity is scoped by
      // orgMemberId. Shortcodes remain project-scoped and use the parent's unique
      // shortcode to distinguish otherwise identical branch slugs.
      const shortcode = isDevelopmentBranch
        ? `${branchSlug}-${parentEnvironment.shortcode}`
        : branchSlug;
      let branchWhere: Prisma.RuntimeEnvironmentWhereUniqueInput;
      if (isDevelopmentBranch) {
        invariant(parentEnvironment.orgMemberId, "Development branches require an org member");
        branchWhere = {
          projectId_slug_orgMemberId: {
            projectId: parentEnvironment.project.id,
            slug: branchSlug,
            orgMemberId: parentEnvironment.orgMemberId,
          },
        };
      } else {
        branchWhere = {
          projectId_shortcode: {
            projectId: parentEnvironment.project.id,
            shortcode,
          },
        };
      }
      const billingPause = await getInitialEnvPauseStateForBillingLimit(
        parentEnvironment.organization.id,
        parentEnvironment.type
      );

      const now = new Date();
      const branch = await this.#prismaClient.runtimeEnvironment.upsert({
        where: branchWhere,
        create: {
          slug: branchSlug,
          apiKey,
          pkApiKey,
          rootApiKeyHiddenAt: now,
          shortcode,
          maximumConcurrencyLimit: parentEnvironment.maximumConcurrencyLimit,
          paused: billingPause.paused,
          pauseSource: billingPause.pauseSource,
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
          orgMember: parentEnvironment.orgMemberId
            ? { connect: { id: parentEnvironment.orgMemberId } }
            : undefined,
          git: git ?? undefined,
        },
        update: {
          git: git ?? undefined,
        },
        include: {
          organization: true,
          project: true,
        },
      });

      const alreadyExisted = branch.createdAt < now;
      await applyBillingLimitPauseAfterEnvCreate(branch);

      return {
        success: true as const,
        alreadyExisted: alreadyExisted,
        branch,
        organization: parentEnvironment.organization,
        project: parentEnvironment.project,
        autoArchivedBranches,
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

async function autoArchiveStaleDevBranches({
  prisma,
  orgFilter,
  parentEnvironment,
  userId,
  limit,
}: {
  prisma: PrismaClient;
  orgFilter: OrgFilter;
  parentEnvironment: {
    id: string;
    type: string;
    orgMemberId: string | null;
    project: { id: string };
  };
  userId?: string;
  limit: number;
}) {
  if (parentEnvironment.type !== "DEVELOPMENT" || !userId) return [];

  try {
    const branches = await prisma.runtimeEnvironment.findMany({
      where: {
        parentEnvironmentId: parentEnvironment.id,
        archivedAt: null,
      },
      select: { id: true, branchName: true, createdAt: true },
    });
    const recentBranches = await devPresence.getRecentBranchIds(
      userId,
      parentEnvironment.project.id
    );
    const connectedBranches = await devPresence.isConnectedMany(
      branches.map((branch) => branch.id)
    );
    const staleBefore = Date.now() - DEV_BRANCH_STALE_AFTER_MS;
    const candidates = branches
      .filter((branch) => {
        if (connectedBranches.get(branch.id)) return false;
        const lastActivity = recentBranches.get(branch.id)?.getTime() ?? branch.createdAt.getTime();
        return lastActivity <= staleBefore;
      })
      .sort((a, b) => {
        const aActivity = recentBranches.get(a.id)?.getTime() ?? a.createdAt.getTime();
        const bActivity = recentBranches.get(b.id)?.getTime() ?? b.createdAt.getTime();
        return aActivity - bActivity;
      })
      .slice(0, DEV_BRANCH_AUTO_ARCHIVE_LIMIT);

    const used = await prisma.runtimeEnvironment.count({
      where: {
        projectId: parentEnvironment.project.id,
        orgMemberId: parentEnvironment.orgMemberId,
        type: "DEVELOPMENT",
        archivedAt: null,
      },
    });
    if (used < limit) return [];

    const archiveService = new ArchiveBranchService(prisma);
    const results = await Promise.all(
      candidates.map((candidate) => archiveService.call(orgFilter, { environmentId: candidate.id }))
    );

    return results.flatMap((result) =>
      result.success && result.branch.branchName
        ? [{ id: result.branch.id, branchName: result.branch.branchName }]
        : []
    );
  } catch (error) {
    logger.warn("Failed to auto-archive stale development branches", {
      projectId: parentEnvironment.project.id,
      error,
    });
    return [];
  }
}

export async function checkBranchLimit({
  prisma,
  organizationId,
  projectId,
  userId,
  type,
  newBranchName,
}: {
  prisma: PrismaClientOrTransaction;
  organizationId: string;
  projectId: string;
  userId?: string;
  type: BranchableEnvironmentType;
  newBranchName?: string;
}) {
  let orgMemberWhere = {};
  if (type === "DEVELOPMENT") {
    invariant(userId, "Cannot use org access for dev server");
    orgMemberWhere = { orgMember: { userId } };
  }

  const usedEnvs = await prisma.runtimeEnvironment.findMany({
    where: {
      projectId,
      type,
      // For PREVIEW, count only branches (exclude the branchable parent). For
      // DEVELOPMENT, the root env counts toward the limit alongside its branches.
      ...(type === "PREVIEW" ? { parentEnvironmentId: { not: null } } : {}),
      ...orgMemberWhere,
      archivedAt: null,
    },
  });

  const count = newBranchName
    ? usedEnvs.filter((env) => env.branchName !== newBranchName).length
    : usedEnvs.length;

  const limitName = type === "PREVIEW" ? "branches" : "branchesDev";
  const baseLimit = await getLimit(organizationId, limitName, 100_000_000);
  const currentPlan = await getCurrentPlan(organizationId);
  const purchasedBranches = currentPlan?.v3Subscription?.addOns?.branches?.purchased ?? 0;
  // We deliberately include purchased PREVIEW branches in DEV limits... (not documented anywhere)
  const limit = baseLimit + purchasedBranches;

  return {
    used: count,
    limit,
    isAtLimit: count >= limit,
  };
}
