import {
  DisplayElementSchema,
  StyleSchema,
} from "@/../../packages/internal/src";
import { z } from "zod";
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

  public async call({ id, userId }: DetailsProps) {
    const event = await this.#prismaClient.eventRecord.findFirst({
      select: {
        id: true,
        name: true,
        payload: true,
        timestamp: true,
        deliveredAt: true,
      },
      where: {
        id,
      },
    });

    if (!event) {
      return undefined;
    }

    return event;
  }
}
