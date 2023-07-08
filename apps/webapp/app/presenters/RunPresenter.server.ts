import {
  ErrorWithStack,
  ErrorWithStackSchema,
  EventSpecificationSchema,
  StyleSchema,
} from "@trigger.dev/internal";
import { PrismaClient, prisma } from "~/db.server";
import { mergeProperties } from "~/utils/mergeProperties.server";

type RunOptions = {
  id: string;
  userId: string;
};

export type Task = NonNullable<
  Awaited<ReturnType<RunPresenter["call"]>>
>["tasks"][number];
export type Event = NonNullable<
  Awaited<ReturnType<RunPresenter["call"]>>
>["event"];

type QueryTask = NonNullable<
  Awaited<ReturnType<RunPresenter["query"]>>
>["tasks"][number];

const taskSelect = {
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
        },
      },
    },
  },
} as const;

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

    const eventSpecification = EventSpecificationSchema.parse(
      run.version.eventSpecification
    );

    const runProperties = mergeProperties(
      run.version.properties,
      run.properties,
      eventSpecification.properties
    );

    const enrichTask = (task: QueryTask) => {
      const { children, ...t } = task;
      return {
        ...t,
        error: t.error ? ErrorWithStackSchema.parse(t.error) : undefined,
        connection: t.runConnection,
        properties: mergeProperties(t.properties, t.outputProperties),
        style: t.style ? StyleSchema.parse(t.style) : undefined,
      };
    };

    type EnrichedTask = ReturnType<typeof enrichTask> & {
      subtasks: EnrichedTask[];
    };

    const recursivelyEnrichTasks = (task: QueryTask[]): EnrichedTask[] => {
      return task.map((t) => {
        const enrichedTask = enrichTask(t);

        return {
          ...enrichedTask,
          subtasks: recursivelyEnrichTasks(t.children),
        };
      });
    };

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
      tasks: recursivelyEnrichTasks(run.tasks),
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
            ...taskSelect,
            children: {
              select: {
                ...taskSelect,
                children: {
                  select: {
                    ...taskSelect,
                    children: {
                      select: {
                        ...taskSelect,
                        children: {
                          select: {
                            ...taskSelect,
                            children: {
                              select: {
                                ...taskSelect,
                              },
                              orderBy: {
                                createdAt: "asc",
                              },
                            },
                          },
                          orderBy: {
                            createdAt: "asc",
                          },
                        },
                      },
                      orderBy: {
                        createdAt: "asc",
                      },
                    },
                  },
                  orderBy: {
                    createdAt: "asc",
                  },
                },
              },
              orderBy: {
                createdAt: "asc",
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
          where: {
            parentId: null,
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
}
