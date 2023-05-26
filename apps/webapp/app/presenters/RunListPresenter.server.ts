import { PrismaClient, prisma } from "~/db.server";

type RunListOptions = {
  userId: string;
  jobId: string;
  cursor?: string;
};

const PAGE_SIZE = 20;

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;

export class RunListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, jobId, cursor }: RunListOptions) {
    const runs = await this.#prismaClient.jobRun.findMany({
      //todo change to a select
      include: {
        environment: {
          select: {
            type: true,
          },
        },
        version: {
          select: {
            version: true,
          },
        },
      },
      where: {
        jobId,
        organization: { members: { some: { userId } } },
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
      take: PAGE_SIZE + 1,
      //skip the cursor if there is one
      skip: cursor ? 1 : 0,
      cursor: cursor
        ? {
            id: cursor,
          }
        : undefined,
    });

    const hasMore = runs.length > PAGE_SIZE;
    return {
      runs: runs.slice(0, PAGE_SIZE),
      hasMore,
      //todo look at Stripe for how to structure the object, needs previous cursor too
      cursor: hasMore ? runs[PAGE_SIZE - 1].id : undefined,
    };
  }
}
