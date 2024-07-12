import { ScheduleMetadataSchema } from '@trigger.dev/core/schemas';
import { type User } from "@trigger.dev/database";
import { type Organization } from "~/models/organization.server";
import { type Project } from "~/models/project.server";
import { calculateNextScheduledEvent } from "~/services/schedules/nextScheduledEvent.server";
import { BasePresenter } from "./v3/basePresenter.server";

const DEFAULT_PAGE_SIZE = 20;

export class ScheduledTriggersPresenter extends BasePresenter {
  public async call({
    userId,
    projectSlug,
    organizationSlug,
    direction = "forward",
    pageSize = DEFAULT_PAGE_SIZE,
    cursor,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    direction?: "forward" | "backward";
    pageSize?: number;
    cursor?: string;
  }) {
    const organization = await this._replica.organization.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: organizationSlug,
        members: { some: { userId } },
      },
    });

    // Find the project scoped to the organization
    const project = await this._replica.project.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: projectSlug,
        organizationId: organization.id,
      },
    });

    const directionMultiplier = direction === "forward" ? 1 : -1;

    const scheduled = await this._replica.scheduleSource.findMany({
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
          projectId: project.id,
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

    const hasMore = scheduled.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? scheduled.at(0)?.id : undefined;
        if (hasMore) {
          next = scheduled[pageSize - 1]?.id;
        }
        break;
      case "backward":
        if (hasMore) {
          previous = scheduled[1]?.id;
          next = scheduled[pageSize]?.id;
        } else {
          next = scheduled[pageSize - 1]?.id;
        }
        break;
    }

    const scheduledToReturn =
      direction === "backward" && hasMore
        ? scheduled.slice(1, pageSize + 1)
        : scheduled.slice(0, pageSize);

    return {
      scheduled: scheduledToReturn.map((s) => {
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
      pagination: {
        next,
        previous,
      },
    };
  }
}
