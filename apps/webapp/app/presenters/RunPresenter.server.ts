import {
  DisplayElementSchema,
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

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ id, userId }: RunOptions) {
    const run = await this.#prismaClient.jobRun.findFirst({
      select: {
        id: true,
        number: true,
        status: true,
        startedAt: true,
        completedAt: true,
        isTest: true,
        version: {
          select: {
            version: true,
          },
        },
        environment: {
          select: {
            type: true,
            slug: true,
          },
        },
        //todo slim these down
        event: true,
        tasks: {
          select: {
            id: true,
            displayKey: true,
            runConnectionId: true,
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
            children: {
              select: {
                id: true,
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

    if (!run) {
      return undefined;
    }

    return {
      id: run.id,
      number: run.number,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      isTest: run.isTest,
      version: run.version.version,
      environment: {
        type: run.environment.type,
        slug: run.environment.slug,
      },
      //todo remove properties
      event: run.event,
      tasks: run.tasks.map((task) => ({
        ...task,
        params: task.params as Record<string, any>,
        elements:
          task.elements == null
            ? []
            : z.array(DisplayElementSchema).parse(task.elements),
        connection: run.runConnections.find(
          (c) => c.id === task.runConnectionId
        ),
        style: task.style ? StyleSchema.parse(task.style) : undefined,
      })),
      runConnections: run.runConnections,
      missingConnections: run.missingConnections,
    };
  }
}
