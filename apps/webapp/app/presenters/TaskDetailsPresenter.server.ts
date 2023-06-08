import {
  DisplayElementSchema,
  StyleSchema,
} from "@/../../packages/internal/src";
import { z } from "zod";
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
        name: true,
        icon: true,
        status: true,
        delayUntil: true,
        noop: true,
        description: true,
        elements: true,
        params: true,
        output: true,
        error: true,
        startedAt: true,
        completedAt: true,
        style: true,
        parentId: true,
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
      elements:
        task.elements == null
          ? []
          : z.array(DisplayElementSchema).parse(task.elements),
      style: task.style ? StyleSchema.parse(task.style) : undefined,
    };
  }
}
