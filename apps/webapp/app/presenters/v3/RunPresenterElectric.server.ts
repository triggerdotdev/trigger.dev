import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";
import { isFinalRunStatus } from "~/v3/taskStatus";

type Result = Awaited<ReturnType<RunPresenter["call"]>>;
export type Run = Result["run"];

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    runFriendlyId,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    runFriendlyId: string;
  }) {
    const run = await this.#prismaClient.taskRun.findFirstOrThrow({
      select: {
        id: true,
        number: true,
        traceId: true,
        spanId: true,
        friendlyId: true,
        status: true,
        completedAt: true,
        logsDeletedAt: true,
        runtimeEnvironment: {
          select: {
            id: true,
            type: true,
            slug: true,
            organizationId: true,
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
      },
      where: {
        friendlyId: runFriendlyId,
        project: {
          slug: projectSlug,
        },
      },
    });

    return {
      run: {
        id: run.id,
        number: run.number,
        friendlyId: run.friendlyId,
        traceId: run.traceId,
        spanId: run.spanId,
        status: run.status,
        isFinished: isFinalRunStatus(run.status),
        completedAt: run.completedAt,
        logsDeletedAt: run.logsDeletedAt,

        environment: {
          id: run.runtimeEnvironment.id,
          organizationId: run.runtimeEnvironment.organizationId,
          type: run.runtimeEnvironment.type,
          slug: run.runtimeEnvironment.slug,
          userId: run.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(run.runtimeEnvironment.orgMember?.user),
        },
      },
    };
  }
}
