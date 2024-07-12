import { type Direction } from "~/components/runs/RunStatuses";
import { type PrismaClient, prisma } from "~/db.server";

type RunListOptions = {
  userId: string;
  webhookId: string;
  direction?: Direction;
  cursor?: string;
};

const PAGE_SIZE = 20;

export type WebhookDeliveryList = Awaited<ReturnType<WebhookDeliveryListPresenter["call"]>>;

export class WebhookDeliveryListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, webhookId, direction = "forward", cursor }: RunListOptions) {
    const directionMultiplier = direction === "forward" ? 1 : -1;

    const runs = await this.#prismaClient.webhookRequestDelivery.findMany({
      select: {
        id: true,
        number: true,
        createdAt: true,
        deliveredAt: true,
        verified: true,
        error: true,
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
      },
      where: {
        webhookId,
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
          next = runs[PAGE_SIZE]?.id;
        } else {
          next = runs[PAGE_SIZE - 1]?.id;
        }
        break;
    }

    const runsToReturn =
      direction === "backward" && hasMore ? runs.slice(1, PAGE_SIZE + 1) : runs.slice(0, PAGE_SIZE);

    return {
      runs: runsToReturn.map((run) => ({
        id: run.id,
        number: run.number,
        createdAt: run.createdAt,
        deliveredAt: run.deliveredAt,
        verified: run.verified,
        error: run.error,
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
