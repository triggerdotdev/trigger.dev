import { PrismaClient, prisma } from "~/db.server";
import { z } from "zod";
import { DirectionSchema } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.jobs.$jobParam._index/route";

export type Direction = z.infer<typeof DirectionSchema>;

type RunListOptions = {
  userId: string;
  jobSlug: string;
  organizationSlug: string;
  projectSlug: string;
  direction?: Direction;
  cursor?: string;
};

const PAGE_SIZE = 20;

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;

export class RunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    jobSlug,
    organizationSlug,
    projectSlug,
    direction = "forward",
    cursor,
  }: RunListOptions) {
    const directionMultiplier = direction === "forward" ? 1 : -1;

    const runs = await this.#prismaClient.jobRun.findMany({
      select: {
        id: true,
        number: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        isTest: true,
        status: true,
        environment: {
          select: {
            type: true,
            slug: true,
            orgMember: {
              select: {
                userId: true,
              },
            },
          },
        },
        version: {
          select: {
            version: true,
          },
        },
      },
      where: {
        job: {
          slug: jobSlug,
        },
        project: {
          slug: projectSlug,
        },
        organization: { slug: organizationSlug, members: { some: { userId } } },
        environment: {
          OR: [
            {
              orgMember: null,
            },
            {
              orgMember: {
                userId,
              },
            },
          ],
        },
      },
      orderBy: [{ id: "desc" }],
      //take an extra page to tell if there are more
      take: directionMultiplier * (PAGE_SIZE + 1),
      //skip the cursor if there is one
      skip: cursor ? 1 : 0,
      cursor: cursor
        ? {
            id: cursor,
          }
        : undefined,
    });

    const hasMore = runs.length > PAGE_SIZE;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? runs.at(0)?.id : undefined;
        if (hasMore) {
          next = runs[PAGE_SIZE - 1]?.id;
        }
        break;
      case "backward":
        if (hasMore) {
          previous = runs[1]?.id;
        }
        next = runs[PAGE_SIZE - 1]?.id;
        break;
    }

    const runsToReturn =
      direction === "backward" && hasMore ? runs.slice(1, PAGE_SIZE + 1) : runs.slice(0, PAGE_SIZE);

    return {
      runs: runsToReturn.map((run) => ({
        id: run.id,
        number: run.number,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
        isTest: run.isTest,
        status: run.status,
        version: run.version?.version ?? "unknown",
        environment: {
          type: run.environment.type,
          slug: run.environment.slug,
          userId: run.environment.orgMember?.userId,
        },
      })),
      pagination: {
        next,
        previous,
      },
    };
  }
}
