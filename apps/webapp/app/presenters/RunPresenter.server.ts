import {
  ErrorWithStack,
  ErrorWithStackSchema,
  EventSpecificationSchema,
  StyleSchema,
} from "@trigger.dev/core";
import { PrismaClient, prisma } from "~/db.server";
import { mergeProperties } from "~/utils/mergeProperties.server";
import { taskListToTree } from "~/utils/taskListToTree";

type RunOptions = {
  id: string;
  userId: string;
};

export type Run = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>;
export type Task = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>["tasks"][number];
export type Event = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>["event"];

type QueryTask = NonNullable<Awaited<ReturnType<RunPresenter["query"]>>>["tasks"][number];

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ id, userId }: RunOptions) {
    const run = await this.query({ id, userId });

    if (!run) {
      return undefined;
    }

    const eventSpecification = EventSpecificationSchema.parse(run.version.eventSpecification);

    const runProperties = mergeProperties(
      run.version.properties,
      run.properties,
      eventSpecification.properties
    );

    //enrich tasks then group subtasks under their parents
    const enrichedTasks = this.enrichTasks(run.tasks);
    const tasks = taskListToTree(enrichedTasks);

    let runError: ErrorWithStack | undefined = undefined;
    let runOutput: string | null | undefined = run.output
      ? JSON.stringify(run.output, null, 2)
      : null;

    if (run.status === "FAILURE") {
      const error = ErrorWithStackSchema.safeParse(run.output);

      if (error.success) {
        runError = error.data;
        runOutput = null;
      } else {
        runError = { message: "Unknown error" };
        runOutput = null;
      }
    }

    return {
      id: run.id,
      number: run.number,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      isTest: run.isTest,
      version: run.version.version,
      output: runOutput,
      properties: runProperties,
      environment: {
        type: run.environment.type,
        slug: run.environment.slug,
      },
      event: run.event,
      tasks,
      runConnections: run.runConnections,
      missingConnections: run.missingConnections,
      error: runError,
    };
  }

  query({ id, userId }: RunOptions) {
    return this.#prismaClient.jobRun.findFirst({
      select: {
        id: true,
        number: true,
        status: true,
        startedAt: true,
        completedAt: true,
        isTest: true,
        properties: true,
        output: true,
        version: {
          select: {
            version: true,
            properties: true,
            eventSpecification: true,
          },
        },
        environment: {
          select: {
            type: true,
            slug: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            payload: true,
            timestamp: true,
            deliveredAt: true,
          },
        },
        tasks: {
          select: {
            id: true,
            displayKey: true,
            name: true,
            icon: true,
            status: true,
            delayUntil: true,
            description: true,
            properties: true,
            outputProperties: true,
            error: true,
            startedAt: true,
            completedAt: true,
            style: true,
            parentId: true,
            runConnection: {
              select: {
                integration: {
                  select: {
                    definitionId: true,
                    title: true,
                    slug: true,
                    definition: {
                      select: {
                        icon: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
        runConnections: {
          select: {
            id: true,
            key: true,
            integration: {
              select: {
                title: true,
                slug: true,
                description: true,
                scopes: true,
                definition: true,
              },
            },
          },
        },
        missingConnections: true,
      },
      where: {
        id,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });
  }

  enrichTasks(tasks: QueryTask[]) {
    return tasks.map((task) => ({
      ...task,
      error: task.error ? ErrorWithStackSchema.parse(task.error) : undefined,
      connection: task.runConnection,
      properties: mergeProperties(task.properties, task.outputProperties),
      style: task.style ? StyleSchema.parse(task.style) : undefined,
    }));
  }
}
