import { GitMeta } from "@trigger.dev/core/v3";
import { type z } from "zod";
import { Prisma, type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { type BranchesOptions } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route";
import { checkBranchLimit } from "~/services/upsertBranch.server";

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
};

export class BranchesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    showArchived = false,
    search,
    page = 1,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
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

    const branchableEnvironment = await this.#prismaClient.runtimeEnvironment.findFirst({
      select: {
        id: true,
      },
      where: {
        projectId: project.id,
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
      };
    }

    const visibleCount = await this.#prismaClient.runtimeEnvironment.count({
      where: {
        projectId: project.id,
        branchName: search
          ? {
              contains: search,
              mode: "insensitive",
            }
          : {
              not: null,
            },
        ...(showArchived ? {} : { archivedAt: null }),
      },
    });

    // Limits
    const limits = await checkBranchLimit(this.#prismaClient, project.organizationId, project.id);

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
        branchName: search
          ? {
              contains: search,
              mode: "insensitive",
            }
          : {
              not: null,
            },
        ...(showArchived ? {} : { archivedAt: null }),
      },
      orderBy: {
        branchName: "asc",
      },
      skip: (page - 1) * BRANCHES_PER_PAGE,
      take: BRANCHES_PER_PAGE,
    });

    const totalBranches = await this.#prismaClient.runtimeEnvironment.count({
      where: {
        projectId: project.id,
        branchName: {
          not: null,
        },
      },
    });

    return {
      branchableEnvironment,
      currentPage: page,
      totalPages: Math.ceil(visibleCount / BRANCHES_PER_PAGE),
      hasBranches: totalBranches > 0,
      branches: branches.flatMap((branch) => {
        if (branch.branchName === null) {
          return [];
        }

        const git = processGitMetadata(branch.git);

        return [
          {
            ...branch,
            branchName: branch.branchName,
            git,
          } as const,
        ];
      }),
      hasFilters,
      limits,
    };
  }
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
  };
}
