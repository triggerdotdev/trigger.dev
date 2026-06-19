import { GitMeta, } from "@trigger.dev/core/v3";
import { DEFAULT_DEV_BRANCH } from "@trigger.dev/core/v3/utils/gitBranch";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { type z } from "zod";
import { type Prisma, type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { type BranchesOptions } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { checkBranchLimit } from "~/services/upsertBranch.server";
import { devPresence } from "./DevPresence.server";
import { sortEnvironments } from "~/utils/environmentSort";

type Result = Awaited<ReturnType<BranchesPresenter["call"]>>;
export type Branch = Result["branches"][number];

const BRANCHES_PER_PAGE = 25;

type Options = z.infer<typeof BranchesOptions>;

export type GitMetaLinks = {
  /** The cleaned repository URL without any username/password */
  repositoryUrl: string;
  /** The branch name */
  branchName: string;
  /** Link to the specific branch */
  branchUrl: string;
  /** Link to the specific commit */
  commitUrl: string;
  /** Link to the pull request (if available) */
  pullRequestUrl?: string;
  /** The pull request number (if available) */
  pullRequestNumber?: number;
  /** The pull request title (if available) */
  pullRequestTitle?: string;
  /** Link to compare this branch with main */
  compareUrl: string;
  /** Shortened commit SHA (first 7 characters) */
  shortSha: string;
  /** Whether the branch has uncommitted changes */
  isDirty: boolean;
  /** The commit message */
  commitMessage: string;
  /** The commit author */
  commitAuthor: string;

  /** The git provider, e.g., `github` */
  provider?: string;

  source?: "trigger_github_app" | "github_actions" | "local";
  ghUsername?: string;
  ghUserAvatarUrl?: string;
};

export class BranchesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    env,
    showArchived = false,
    search,
    page = 1,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    env: "preview" | "development";
  } & Options) {
    const project = await this.#prismaClient.project.findFirst({
      select: {
        id: true,
        organizationId: true,
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

    // TODO audit mishmash of preview/developement preview/dev stg/dev PREVIEW/DEVELOPMENT
    const envType = env === "preview" ? "PREVIEW" : "DEVELOPMENT";

    const branchableEnvironment = await this.#prismaClient.runtimeEnvironment.findFirst({
      select: {
        id: true,
      },
      where: {
        projectId: project.id,
        type: envType,
        isBranchableEnvironment: true,
      },
    });

    const hasFilters = !!showArchived || (search !== undefined && search !== "");

    if (!branchableEnvironment) {
      return {
        branchableEnvironment: null,
        currentPage: page,
        totalPages: 0,
        hasBranches: false,
        branches: [],
        hasFilters: false,
        limits: {
          used: 0,
          limit: 0,
          isAtLimit: true,
        },
        canPurchaseBranches: false,
        extraBranches: 0,
        branchPricing: null,
        maxBranchQuota: 0,
        planBranchLimit: 0,
      };
    }

    // The default DEV branch has no branchName (it's the root dev env, stored
    // with branchName: null), so searching for it by name wouldn't display it.
    // Hacky way around that: always include the null-branchName root env.
    const branchNameWhere = envType === "DEVELOPMENT" ?
      search
        ? { OR: [{ contains: search, mode: "insensitive" as const }, { is: null }] }
        : {} :
      search
        ? { contains: search, mode: "insensitive" as const }
        : { not: null };
    const orgMemberWhere = envType === "DEVELOPMENT" ? { orgMember: { userId } } : {};


    const visibleCount = await this.#prismaClient.runtimeEnvironment.count({
      where: {
        projectId: project.id,
        type: envType,
        branchName: branchNameWhere,
        ...orgMemberWhere,
        ...(showArchived ? {} : { archivedAt: null }),
      },
    });

    const limits = await checkBranchLimit({ prisma: this.#prismaClient, organizationId: project.organizationId, projectId: project.id, userId, env });

    const [currentPlan, plans] = await Promise.all([
      getCurrentPlan(project.organizationId),
      getPlans(),
    ]);

    const canPurchaseBranches =
      currentPlan?.v3Subscription?.plan?.limits.branches.canExceed === true;
    const extraBranches = currentPlan?.v3Subscription?.addOns?.branches?.purchased ?? 0;
    const maxBranchQuota = currentPlan?.v3Subscription?.addOns?.branches?.quota ?? 0;
    const planBranchLimit = currentPlan?.v3Subscription?.plan?.limits.branches.number ?? 0;
    const branchPricing = plans?.addOnPricing.branches ?? null;

    const branches = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        slug: true,
        branchName: true,
        type: true,
        archivedAt: true,
        createdAt: true,
        git: true,
      },
      where: {
        projectId: project.id,
        type: envType,
        branchName: branchNameWhere,
        ...orgMemberWhere,
        ...(showArchived ? {} : { archivedAt: null }),
      },
      orderBy: {
        branchName: "asc",
      },
      skip: (page - 1) * BRANCHES_PER_PAGE,
      take: BRANCHES_PER_PAGE,
    });

    const totalBranchesWhere = envType === "DEVELOPMENT" ? {} : { not: null };
    const totalBranches = await this.#prismaClient.runtimeEnvironment.count({
      where: {
        projectId: project.id,
        type: envType,
        branchName: totalBranchesWhere,
        ...orgMemberWhere,
      },
    });


    const branchesFiltered = branches
      .filter((branch) => envType === "DEVELOPMENT" || branch.branchName !== null)
      .map((branch) => ({
        ...branch,
        git: processGitMetadata(branch.git),
        branchName: branch.branchName ?? DEFAULT_DEV_BRANCH,
      }));

    const branchesWithActivity = await hydrateEnvsWithActivity(userId, project.id, branchesFiltered);
    const branchesSorted = sortEnvironments(branchesWithActivity);

    return {
      branchableEnvironment,
      currentPage: page,
      totalPages: Math.ceil(visibleCount / BRANCHES_PER_PAGE),
      hasBranches: totalBranches > 0,
      branches: branchesSorted,
      hasFilters,
      limits,
      canPurchaseBranches,
      extraBranches,
      branchPricing,
      maxBranchQuota,
      planBranchLimit,
    };
  }
}

export async function hydrateEnvsWithActivity<T extends { type: RuntimeEnvironmentType; id: string }>
  (userId: string, projectId: string, environments: T[]): Promise<Array<T & { lastActivity: Date | undefined; isConnected: boolean | undefined }>> {
  const recentDevBranchIds = await devPresence.getRecentBranchIds(userId, projectId);

  return Promise.all(environments.map(async (env) => {
    if (env.type !== "DEVELOPMENT") {
      return { ...env, lastActivity: undefined, isConnected: undefined };
    }

    const devHit = recentDevBranchIds.get(env.id);
    const lastActivity = devHit === undefined ? undefined : devHit;
    // TODO change dev-presence to a different data structure to avoid N calls?
    const isConnected = devHit === undefined ? undefined : await devPresence.isConnected(env.id);
    return { ...env, lastActivity, isConnected };
  }));
}

export function processGitMetadata(data: Prisma.JsonValue): GitMetaLinks | null {
  if (!data) return null;

  const parsed = GitMeta.safeParse(data);
  if (!parsed.success) {
    return null;
  }

  if (!parsed.data.remoteUrl) {
    return null;
  }

  // Clean the remote URL by removing any username/password and ensuring it's a proper GitHub URL
  const cleanRemoteUrl = (() => {
    try {
      const url = new URL(parsed.data.remoteUrl);
      // Remove any username/password from the URL
      url.username = "";
      url.password = "";
      // Ensure we're using https
      url.protocol = "https:";
      // Remove any trailing .git
      return url.toString().replace(/\.git$/, "");
    } catch (e) {
      // If URL parsing fails, try to clean it manually
      return parsed.data.remoteUrl
        .replace(/^git@github\.com:/, "https://github.com/")
        .replace(/^https?:\/\/[^@]+@/, "https://")
        .replace(/\.git$/, "");
    }
  })();

  if (!parsed.data.commitRef || !parsed.data.commitSha) return null;

  const shortSha = parsed.data.commitSha.slice(0, 7);

  return {
    repositoryUrl: cleanRemoteUrl,
    branchName: parsed.data.commitRef,
    branchUrl: `${cleanRemoteUrl}/tree/${parsed.data.commitRef}`,
    commitUrl: `${cleanRemoteUrl}/commit/${parsed.data.commitSha}`,
    pullRequestUrl: parsed.data.pullRequestNumber
      ? `${cleanRemoteUrl}/pull/${parsed.data.pullRequestNumber}`
      : undefined,
    pullRequestNumber: parsed.data.pullRequestNumber,
    pullRequestTitle: parsed.data.pullRequestTitle,
    compareUrl: `${cleanRemoteUrl}/compare/main...${parsed.data.commitRef}`,
    shortSha,
    isDirty: parsed.data.dirty ?? false,
    commitMessage: parsed.data.commitMessage ?? "",
    commitAuthor: parsed.data.commitAuthorName ?? "",
    provider: parsed.data.provider,
    source: parsed.data.source,
    ghUsername: parsed.data.ghUsername,
    ghUserAvatarUrl: parsed.data.ghUserAvatarUrl,
  };
}
