import { PrismaClient, prisma } from "~/db.server";

type DetailsProps = {
  id: string;
  userId: string;
};

export type DetailedEvent = NonNullable<
  Awaited<ReturnType<EventDetailsPresenter["call"]>>
>;

export class EventDetailsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(runId: string) {
    const { event } = await this.#prismaClient.jobRun.findUniqueOrThrow({
      where: {
        id: runId,
      },
      select: {
        event: {
          select: {
            id: true,
            name: true,
            payload: true,
            timestamp: true,
            deliveredAt: true,
          },
        },
      },
    });

    return event;
  }
}
