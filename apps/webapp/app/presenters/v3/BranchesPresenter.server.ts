import { z } from "zod";
import { type PrismaClient, prisma } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { type BranchesOptions } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route";
import { checkBranchLimit } from "~/services/upsertBranch.server";
import { getLimit } from "~/services/platform.v3.server";

type Result = Awaited<ReturnType<BranchesPresenter["call"]>>;
export type Branch = Result["branches"][number];

const BRANCHES_PER_PAGE = 10;

type Options = z.infer<typeof BranchesOptions>;

export const BranchGit = z
  .object({
    repo: z.string(),
    pr: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
  })
  .nullable();

export type BranchGit = z.infer<typeof BranchGit>;

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
        totalCount: 0,
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

    return {
      branchableEnvironment,
      currentPage: page,
      totalPages: Math.ceil(visibleCount / BRANCHES_PER_PAGE),
      totalCount: visibleCount,
      branches: branches.flatMap((branch) => {
        if (branch.branchName === null) {
          return [];
        }

        return [
          {
            ...branch,
            branchName: branch.branchName,
            git: BranchGit.parse(branch.git),
          } as const,
        ];
      }),
      hasFilters,
      limits,
    };
  }
}
