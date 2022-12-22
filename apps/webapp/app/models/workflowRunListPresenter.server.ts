import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "./organization.server";
import type { User } from "./user.server";
import type { Workflow } from "./workflow.server";

export class WorkflowRunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    userId,
    organizationSlug,
    workflowSlug,
    pageSize = 2,
    searchParams,
  }: {
    userId: User["id"];
    organizationSlug: Organization["slug"];
    workflowSlug: Workflow["slug"];
    pageSize?: number;
    searchParams: URLSearchParams;
  }) {
    const searchObject = Object.fromEntries(searchParams.entries());
    const page = Number(searchObject.page) || 1;

    const offset = (page - 1) * pageSize;
    const total = await this.#prismaClient.workflowRun.count({
      where: {
        workflow: {
          slug: workflowSlug,
        },
      },
    });

    const runs = await this.#prismaClient.workflowRun.findMany({
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        status: true,
        isTest: true,
      },
      where: {
        workflow: {
          slug: workflowSlug,
          organization: {
            slug: organizationSlug,
            users: {
              some: {
                id: userId,
              },
            },
          },
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      skip: offset,
      take: pageSize,
    });

    const filters = Object.fromEntries(
      Object.entries(searchObject).filter(([key]) => key !== "page")
    );

    return {
      runs,
      page,
      pageCount: Math.ceil(total / pageSize),
      total,
      filters,
      pageSize,
    };
  }
}
