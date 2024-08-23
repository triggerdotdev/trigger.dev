import { RedactSchema, StyleSchema } from "@trigger.dev/core";
import { $replica, PrismaClient, prisma } from "~/db.server";
import { mergeProperties } from "~/utils/mergeProperties.server";
import { Redactor } from "~/utils/redactor";

type DetailsProps = {
  id: string;
  userId: string;
};

export class TaskDetailsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ id, userId }: DetailsProps) {
    const task = await $replica.task.findFirst({
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
        outputProperties: true,
        params: true,
        output: true,
        outputIsUndefined: true,
        error: true,
        startedAt: true,
        completedAt: true,
        style: true,
        parentId: true,
        redact: true,
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
      redact: undefined,
      output: JSON.stringify(
        this.#stringifyOutputWithRedactions(task.output, task.redact),
        null,
        2
      ),
      connection: task.runConnection,
      params: task.params as Record<string, any>,
      properties: mergeProperties(task.properties, task.outputProperties),
      style: task.style ? StyleSchema.parse(task.style) : undefined,
    };
  }

  #stringifyOutputWithRedactions(output: any, redact: unknown): any {
    if (!output) {
      return output;
    }

    const parsedRedact = RedactSchema.safeParse(redact);

    if (!parsedRedact.success) {
      return output;
    }

    const paths = parsedRedact.data.paths;

    const redactor = new Redactor(paths);

    return redactor.redact(output);
  }
}
