import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { Organization } from "./organization.server";
import type { User } from "./user.server";
import type { Workflow } from "./workflow.server";

const statusSchema = z.union([
  z.literal("PENDING"),
  z.literal("RUNNING"),
  z.literal("SUCCESS"),
  z.literal("ERROR"),
]);

const SearchParamsSchema = z.object({
  page: z.coerce.number().default(1),
  statuses: z.preprocess((arg) => {
    if (arg === undefined || typeof arg !== "string") {
      return undefined;
    }
    const statuses = arg.split(",");
    if (statuses.length === 0) {
      return undefined;
    }
    return statuses;
  }, z.array(statusSchema).optional().default(["PENDING", "RUNNING", "SUCCESS", "ERROR"])),
});

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
    const searchEntries = Object.fromEntries(searchParams.entries());
    const { page, statuses } = SearchParamsSchema.parse(searchEntries);

    console.log("page", page);
    console.log("statuses", statuses);

    const offset = (page - 1) * pageSize;
    const total = await this.#prismaClient.workflowRun.count({
      where: {
        workflow: {
          slug: workflowSlug,
        },
        status: {
          in: statuses,
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
        status: {
          in: statuses,
        },
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
      pageCount: Math.ceil(total / pageSize),
      total,
      filters: {
        statuses,
      },
      hasFilters: statuses.length !== 4,
      pageSize,
    };
  }
}
