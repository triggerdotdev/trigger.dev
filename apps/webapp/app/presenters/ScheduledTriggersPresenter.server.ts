import { User } from "@trigger.dev/database";
import { ScheduleMetadataSchema } from "../../../../packages/core/src";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { calculateNextScheduledEvent } from "~/services/schedules/nextScheduledEvent.server";

export class ScheduledTriggersPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
  }) {
    const scheduled = await this.#prismaClient.scheduleSource.findMany({
      select: {
        id: true,
        key: true,
        active: true,
        schedule: true,
        lastEventTimestamp: true,
        environment: {
          select: {
            type: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        metadata: true,
        dynamicTrigger: true,
      },
      where: {
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
          organization: {
            slug: organizationSlug,
            members: {
              some: {
                userId,
              },
            },
          },
          project: {
            slug: projectSlug,
          },
        },
      },
    });

    return {
      scheduled: scheduled.map((s) => {
        const schedule = ScheduleMetadataSchema.parse(s.schedule);
        const nextEventTimestamp = s.active
          ? calculateNextScheduledEvent(schedule, s.lastEventTimestamp)
          : undefined;

        return {
          ...s,
          schedule,
          nextEventTimestamp,
        };
      }),
    };
  }
}
