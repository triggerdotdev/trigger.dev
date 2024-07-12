import { type PrismaClient, prisma } from "~/db.server";

export type Event = NonNullable<Awaited<ReturnType<EventPresenter["call"]>>>;

export class EventPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    eventId,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    eventId: string;
  }) {
    // Find the organization that the user is a member of
    const organization = await this.#prismaClient.organization.findFirstOrThrow({
      where: {
        slug: organizationSlug,
        members: { some: { userId } },
      },
    });

    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      where: {
        slug: projectSlug,
        organizationId: organization.id,
      },
    });

    const event = await this.#prismaClient.eventRecord.findFirst({
      select: {
        id: true,
        name: true,
        payload: true,
        context: true,
        timestamp: true,
        deliveredAt: true,
      },
      where: {
        id: eventId,
        projectId: project.id,
        organizationId: organization.id,
      },
    });

    if (!event) {
      throw new Error("Could not find Event");
    }

    return {
      id: event.id,
      name: event.name,
      timestamp: event.timestamp,
      payload: JSON.stringify(event.payload, null, 2),
      context: JSON.stringify(event.context, null, 2),
      deliveredAt: event.deliveredAt,
    };
  }
}
