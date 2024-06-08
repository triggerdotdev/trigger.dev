import { PrismaClient, prisma } from "~/db.server";
import { TestSearchParams } from "~/routes/_app.orgs.$organizationSlug.projects.v3.$projectParam.test/route";
import { sortEnvironments } from "~/utils/environmentSort";
import { createSearchParams } from "~/utils/searchParams";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";

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
                type: {
                  in: ["PREVIEW", "STAGING", "PRODUCTION"],
                },
              },
              {
                type: "DEVELOPMENT",
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

    const currentDeployment = await findCurrentWorkerDeployment(matchingEnvironment.id);

    const tasks = currentDeployment?.worker?.tasks ?? [];

    return {
      hasSelectedEnvironment: true as const,
      environments,
      selectedEnvironment: matchingEnvironment,
      tasks: tasks.map((task) => {
        return {
          id: task.id,
          taskIdentifier: task.slug,
          filePath: task.filePath,
          exportName: task.exportName,
          friendlyId: task.friendlyId,
          triggerSource: task.triggerSource,
        };
      }),
    };
  }
}
