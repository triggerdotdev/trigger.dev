import { type PrismaClient, prisma } from "~/db.server";

export type DetailedEvent = NonNullable<Awaited<ReturnType<TriggerDetailsPresenter["call"]>>>;

export class TriggerDetailsPresenter {
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
            eventId: true,
            name: true,
            payload: true,
            context: true,
            timestamp: true,
            deliveredAt: true,
            externalAccount: {
              select: {
                identifier: true,
              },
            },
          },
        },
      },
    });

    return {
      id: event.eventId,
      name: event.name,
      payload: JSON.stringify(event.payload, null, 2),
      context: JSON.stringify(event.context, null, 2),
      timestamp: event.timestamp,
      deliveredAt: event.deliveredAt,
      externalAccount: event.externalAccount
        ? {
            identifier: event.externalAccount.identifier,
          }
        : undefined,
    };
  }
}
