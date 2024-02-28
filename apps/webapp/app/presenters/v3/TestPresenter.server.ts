import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

type TaskListOptions = {
  userId: string;
  projectSlug: string;
};

export type TaskList = Awaited<ReturnType<TestPresenter["call"]>>;
export type TaskListItem = TaskList["tasks"][0];

export class TestPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug }: TaskListOptions) {
    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
          select: {
            id: true,
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
      },
      where: {
        slug: projectSlug,
      },
    });

    //get all possible tasks
    const tasks = await this.#prismaClient.$queryRaw<
      {
        id: string;
        version: string;
        runtimeEnvironmentId: string;
        taskIdentifier: string;
        filePath: string;
        exportName: string;
        friendlyId: string;
      }[]
    >`
    WITH workers AS (
      SELECT 
            bw.*,
            ROW_NUMBER() OVER(PARTITION BY bw."runtimeEnvironmentId" ORDER BY bw.version DESC) AS rn
      FROM 
            "BackgroundWorker" bw
      WHERE "projectId" = ${project.id}
    ),
    latest_workers AS (SELECT * FROM workers WHERE rn = 1)
    SELECT "BackgroundWorkerTask".id, version, "BackgroundWorkerTask"."runtimeEnvironmentId", slug as "taskIdentifier", "filePath", "exportName", "BackgroundWorkerTask"."friendlyId" 
    FROM latest_workers
    JOIN "BackgroundWorkerTask" ON "BackgroundWorkerTask"."workerId" = latest_workers.id;;
    `;

    return {
      tasks: tasks.map((task) => {
        const environment = project.environments.find(
          (env) => env.id === task.runtimeEnvironmentId
        );

        if (!environment) {
          throw new Error(`Environment not found for Task ${task.id}`);
        }

        return {
          id: task.id,
          version: task.version,
          taskIdentifier: task.taskIdentifier,
          filePath: task.filePath,
          exportName: task.exportName,
          friendlyId: task.friendlyId,
          environment: {
            type: environment.type,
            slug: environment.slug,
            userId: environment.orgMember?.user.id,
            userName: getUsername(environment.orgMember?.user),
          },
        };
      }),
    };
  }
}
