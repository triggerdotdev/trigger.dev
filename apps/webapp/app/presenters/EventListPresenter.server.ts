import { type PrismaClient, prisma } from "~/db.server";
import { type Direction, type FilterableEnvironment } from "~/components/runs/RunStatuses";
import { getUsername } from "~/utils/username";

type EventListOptions = {
  userId: string;
  organizationSlug: string;
  projectSlug: string;
  direction?: Direction;
  filterEnvironment?: FilterableEnvironment;
  cursor?: string;
  pageSize?: number;
  from?: number;
  to?: number;
};

const DEFAULT_PAGE_SIZE = 20;

export type EventList = Awaited<ReturnType<EventListPresenter["call"]>>;

export class EventListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    filterEnvironment,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
    from,
    to,
  }: EventListOptions) {
    const directionMultiplier = direction === "forward" ? 1 : -1;

    // Find the organization that the user is a member of
    const organization = await this.#prismaClient.organization.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: organizationSlug,
        members: { some: { userId } },
      },
    });

    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: projectSlug,
        organizationId: organization.id,
      },
    });

    const events = await this.#prismaClient.eventRecord.findMany({
      select: {
        id: true,
        name: true,
        deliverAt: true,
        deliveredAt: true,
        isTest: true,
        createdAt: true,
        cancelledAt: true,
        environment: {
          select: {
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
        runs: {
          select: {
            id: true,
          },
        },
      },
      where: {
        internal: false,
        name: {
          notIn: ["trigger.scheduled", "dev.trigger.scheduled"],
        },
        projectId: project.id,
        organizationId: organization.id,
        environment: filterEnvironment ? { type: filterEnvironment } : undefined,
        createdAt: {
          gte: from ? new Date(from).toISOString() : undefined,
          lte: to ? new Date(to).toISOString() : undefined,
        },
      },
      orderBy: [{ id: "desc" }],
      //take an extra record to tell if there are more
      take: directionMultiplier * (pageSize + 1),
      //skip the cursor if there is one
      skip: cursor ? 1 : 0,
      cursor: cursor
        ? {
            id: cursor,
          }
        : undefined,
    });

    const hasMore = events.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? events.at(0)?.id : undefined;
        if (hasMore) {
          next = events[pageSize - 1]?.id;
        }
        break;
      case "backward":
        if (hasMore) {
          previous = events[1]?.id;
          next = events[pageSize]?.id;
        } else {
          next = events[pageSize - 1]?.id;
        }
        break;
    }

    const eventsToReturn =
      direction === "backward" && hasMore
        ? events.slice(1, pageSize + 1)
        : events.slice(0, pageSize);

    return {
      events: eventsToReturn.map((event) => ({
        id: event.id,
        name: event.name,
        deliverAt: event.deliverAt,
        deliveredAt: event.deliveredAt,
        createdAt: event.createdAt,
        cancelledAt: event.cancelledAt,
        isTest: event.isTest,
        environment: {
          type: event.environment.type,
          slug: event.environment.slug,
          userId: event.environment.orgMember?.user.id,
          userName: getUsername(event.environment.orgMember?.user),
        },
        runs: event.runs.length,
      })),
      pagination: {
        next,
        previous,
      },
    };
  }
}
