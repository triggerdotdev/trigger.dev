import { TaskTriggerSource } from "@trigger.dev/database";
import { sqlDatabaseSchema, PrismaClient, prisma } from "~/db.server";
import { TestSearchParams } from "~/routes/_app.orgs.$organizationSlug.projects.v3.$projectParam.test/route";
import { sortEnvironments } from "~/utils/environmentSort";
import { createSearchParams } from "~/utils/searchParams";
import { getUsername } from "~/utils/username";

type TaskListOptions = {
  userId: string;
  projectSlug: string;
  url: string;
};

export type TaskList = Awaited<ReturnType<TestPresenter["call"]>>;
export type TaskListItem = NonNullable<TaskList["tasks"]>[0];
export type SelectedEnvironment = NonNullable<TaskList["selectedEnvironment"]>;

export class TestPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, url }: TaskListOptions) {
    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
          select: {
            id: true,
            type: true,
            slug: true,
          },
          where: {
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
          },
        },
      },
      where: {
        slug: projectSlug,
      },
    });

    const environments = sortEnvironments(
      project.environments.map((environment) => ({
        id: environment.id,
        type: environment.type,
        slug: environment.slug,
      }))
    );

    const searchParams = createSearchParams(url, TestSearchParams);

    //no environmentId
    if (!searchParams.success) {
      return {
        hasSelectedEnvironment: false as const,
        environments,
      };
    }

    //default to dev environment
    const environment = searchParams.params.get("environment") ?? "dev";

    //is the environmentId valid?
    const matchingEnvironment = project.environments.find((env) => env.slug === environment);
    if (!matchingEnvironment) {
      return {
        hasSelectedEnvironment: false as const,
        environments,
      };
    }

    //get all possible tasks
    const tasks = await this.#prismaClient.$queryRaw<
      {
        id: string;
        version: string;
        taskIdentifier: string;
        filePath: string;
        exportName: string;
        friendlyId: string;
        triggerSource: TaskTriggerSource;
      }[]
    >`WITH workers AS (
      SELECT 
            bw.*,
            ROW_NUMBER() OVER(ORDER BY string_to_array(bw.version, '.')::int[] DESC) AS rn
      FROM 
            ${sqlDatabaseSchema}."BackgroundWorker" bw
      WHERE "runtimeEnvironmentId" = ${matchingEnvironment.id}
    ),
    latest_workers AS (SELECT * FROM workers WHERE rn = 1)
    SELECT bwt.id, version, slug as "taskIdentifier", "filePath", "exportName", bwt."friendlyId", bwt."triggerSource"
    FROM latest_workers
    JOIN ${sqlDatabaseSchema}."BackgroundWorkerTask" bwt ON bwt."workerId" = latest_workers.id
    ORDER BY bwt."exportName" ASC;
    `;

    return {
      hasSelectedEnvironment: true as const,
      environments,
      selectedEnvironment: matchingEnvironment,
      tasks: tasks.map((task) => {
        return {
          id: task.id,
          version: task.version,
          taskIdentifier: task.taskIdentifier,
          filePath: task.filePath,
          exportName: task.exportName,
          friendlyId: task.friendlyId,
          triggerSource: task.triggerSource,
        };
      }),
    };
  }
}
