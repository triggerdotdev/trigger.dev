import { DisplayPropertiesSchema, StyleSchema } from "@trigger.dev/internal";
import { PrismaClient, prisma } from "~/db.server";

type DetailsProps = {
  id: string;
  userId: string;
};

export type DetailedTask = NonNullable<
  Awaited<ReturnType<TaskDetailsPresenter["call"]>>
>;

export class TaskDetailsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ id, userId }: DetailsProps) {
    const task = await this.#prismaClient.task.findFirst({
      select: {
        id: true,
        displayKey: true,
        runConnection: {
          select: {
            id: true,
            key: true,
            connection: {
              select: {
                metadata: true,
                connectionType: true,
                integration: {
                  select: {
                    title: true,
                    slug: true,
                    description: true,
                    scopes: true,
                    definition: true,
                    authMethod: {
                      select: {
                        type: true,
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        name: true,
        icon: true,
        status: true,
        delayUntil: true,
        noop: true,
        description: true,
        properties: true,
        params: true,
        output: true,
        error: true,
        startedAt: true,
        completedAt: true,
        style: true,
        parentId: true,
        attempts: {
          select: {
            number: true,
            status: true,
            error: true,
            runAt: true,
            updatedAt: true,
          },
          orderBy: {
            number: "asc",
          },
        },
      },
      where: {
        id,
      },
    });

    if (!task) {
      return undefined;
    }

    return {
      ...task,
      connection: task.runConnection,
      params: task.params as Record<string, any>,
      properties:
        task.properties == null
          ? []
          : DisplayPropertiesSchema.parse(task.properties),
      style: task.style ? StyleSchema.parse(task.style) : undefined,
    };
  }
}
