import {
  DisplayElement,
  DisplayElementSchema,
  ErrorWithStack,
  ErrorWithStackSchema,
  StyleSchema,
} from "@/../../packages/internal/src";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";

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

const ElementsSchema = z.array(DisplayElementSchema);

const taskSelect = {
  id: true,
  displayKey: true,
  name: true,
  icon: true,
  status: true,
  delayUntil: true,
  description: true,
  elements: true,
  error: true,
  startedAt: true,
  completedAt: true,
  style: true,
  parentId: true,
  runConnection: {
    select: {
      apiConnection: {
        select: {
          client: {
            select: {
              integrationIdentifier: true,
              title: true,
            },
          },
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

    //merge the elements from the version and the run, with the run elements taking precedence
    const mergedElements = new Map<string, DisplayElement>();
    if (run.version.elements) {
      const elements = ElementsSchema.parse(run.version.elements);
      for (const element of elements) {
        mergedElements.set(element.label, element);
      }
    }
    if (run.elements) {
      const elements = ElementsSchema.parse(run.elements);
      for (const element of elements) {
        mergedElements.set(element.label, element);
      }
    }

    const enrichTask = (task: QueryTask) => {
      const { children, ...t } = task;
      return {
        ...t,
        connection: t.runConnection,
        elements:
          t.elements == null
            ? []
            : z.array(DisplayElementSchema).parse(t.elements),
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
      runError = ErrorWithStackSchema.parse(run.output);
      runOutput = undefined;
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
      elements: Array.from(mergedElements.values()),
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
        elements: true,
        output: true,
        version: {
          select: {
            version: true,
            elements: true,
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
                            },
                          },
                        },
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
          where: {
            parentId: null,
          },
        },
        runConnections: {
          select: {
            id: true,
            key: true,
            apiConnection: {
              select: {
                metadata: true,
                connectionType: true,
                client: {
                  select: {
                    title: true,
                    slug: true,
                    description: true,
                    scopes: true,
                    integrationIdentifier: true,
                    integrationAuthMethod: true,
                  },
                },
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
