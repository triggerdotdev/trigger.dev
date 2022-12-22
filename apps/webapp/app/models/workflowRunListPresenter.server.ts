import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { Organization } from "./organization.server";
import { User } from "./user.server";
import { Workflow } from "./workflow.server";

export class WorkflowRunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    userId,
    organizationSlug,
    workflowSlug,
    pageSize = 20,
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

    return {
      runs,
      page,
      total,
    };
  }
}
