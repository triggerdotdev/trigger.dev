import {
  Direction,
  FilterableEnvironment,
  FilterableStatus,
  filterableStatuses,
} from "~/components/runs/RunStatuses";
import { getUsername } from "~/utils/username";
import { BasePresenter } from "./v3/basePresenter.server";

type RunListOptions = {
  userId: string;
  eventId?: string;
  jobSlug?: string;
  organizationSlug: string;
  projectSlug: string;
  direction?: Direction;
  filterStatus?: FilterableStatus;
  filterEnvironment?: FilterableEnvironment;
  cursor?: string;
  pageSize?: number;
  from?: number;
  to?: number;
};

const DEFAULT_PAGE_SIZE = 20;

export type RunList = Awaited<ReturnType<RunListPresenter["call"]>>;

export class RunListPresenter extends BasePresenter {
  public async call({
    userId,
    eventId,
    jobSlug,
    organizationSlug,
    projectSlug,
    filterEnvironment,
    filterStatus,
    direction = "forward",
    cursor,
    pageSize = DEFAULT_PAGE_SIZE,
    from,
    to,
  }: RunListOptions) {
    const filterStatuses = filterStatus ? filterableStatuses[filterStatus] : undefined;

    const directionMultiplier = direction === "forward" ? 1 : -1;

    // Find the organization that the user is a member of
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

    const job = jobSlug
      ? await this._replica.job.findFirstOrThrow({
          where: {
            slug: jobSlug,
            projectId: project.id,
          },
        })
      : undefined;

    const event = eventId
      ? await this._replica.eventRecord.findUnique({ where: { id: eventId } })
      : undefined;

    const runs = await this._replica.jobRun.findMany({
      select: {
        id: true,
        number: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        executionDuration: true,
        isTest: true,
        status: true,
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
        version: {
          select: {
            version: true,
          },
        },
        job: {
          select: {
            slug: true,
            title: true,
          },
        },
      },
      where: {
        eventId: event?.id,
        jobId: job?.id,
        projectId: project.id,
        organizationId: organization.id,
        status: filterStatuses ? { in: filterStatuses } : undefined,
        environment: filterEnvironment ? { type: filterEnvironment } : undefined,
        startedAt: {
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

    const hasMore = runs.length > pageSize;

    //get cursors for next and previous pages
    let next: string | undefined;
    let previous: string | undefined;
    switch (direction) {
      case "forward":
        previous = cursor ? runs.at(0)?.id : undefined;
        if (hasMore) {
          next = runs[pageSize - 1]?.id;
        }
        break;
      case "backward":
        if (hasMore) {
          previous = runs[1]?.id;
          next = runs[pageSize]?.id;
        } else {
          next = runs[pageSize - 1]?.id;
        }
        break;
    }

    const runsToReturn =
      direction === "backward" && hasMore ? runs.slice(1, pageSize + 1) : runs.slice(0, pageSize);

    return {
      runs: runsToReturn.map((run) => ({
        id: run.id,
        number: run.number,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        createdAt: run.createdAt,
        executionDuration: run.executionDuration,
        isTest: run.isTest,
        status: run.status,
        version: run.version?.version ?? "unknown",
        environment: {
          type: run.environment.type,
          slug: run.environment.slug,
          userId: run.environment.orgMember?.user.id,
          userName: getUsername(run.environment.orgMember?.user),
        },
        job: run.job,
      })),
      pagination: {
        next,
        previous,
      },
    };
  }
}
