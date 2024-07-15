import { type ErrorWithStack , ErrorWithStackSchema , EventSpecificationSchema , StyleSchema } from '@trigger.dev/core/schemas';
import { type PrismaClient, prisma } from "~/db.server";
import { isRunCompleted, runBasicStatus } from "~/models/jobRun.server";
import { mergeProperties } from "~/utils/mergeProperties.server";
import { taskListToTree } from "~/utils/taskListToTree";
import { getUsername } from "~/utils/username";

type RunOptions = {
  id: string;
  userId: string;
};

export type ViewRun = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>;
export type ViewTask = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>["tasks"][number];
export type ViewEvent = NonNullable<Awaited<ReturnType<RunPresenter["call"]>>>["event"];

type QueryEvent = NonNullable<Awaited<ReturnType<RunPresenter["query"]>>>["event"];
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
      basicStatus: runBasicStatus(run.status),
      isFinished: isRunCompleted(run.status),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      isTest: run.isTest,
      version: run.version.version,
      output: runOutput,
      properties: runProperties,
      environment: {
        type: run.environment.type,
        slug: run.environment.slug,
        userId: run.environment.orgMember?.user.id,
        userName: getUsername(run.environment.orgMember?.user),
      },
      event: this.#prepareEventData(run.event),
      tasks,
      runConnections: run.runConnections,
      missingConnections: run.missingConnections,
      error: runError,
      executionDuration: run.executionDuration,
      executionCount: run.executionCount,
    };
  }

  #prepareEventData(event: QueryEvent) {
    return {
      id: event.eventId,
      name: event.name,
      payload: JSON.stringify(event.payload),
      context: JSON.stringify(event.context),
      timestamp: event.timestamp,
      deliveredAt: event.deliveredAt,
      externalAccount: event.externalAccount
        ? {
            identifier: event.externalAccount.identifier,
          }
        : undefined,
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
        executionCount: true,
        executionDuration: true,
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
        event: {
          select: {
            eventId: true,
            name: true,
            payload: true,
            context: true,
            timestamp: true,
            deliveredAt: true,
            externalAccount: {
              select: {
                identifier: true,
              },
            },
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
            noop: true,
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
