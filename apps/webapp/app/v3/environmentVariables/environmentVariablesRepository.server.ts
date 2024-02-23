import { PrismaClient } from "@trigger.dev/database";
import { $transaction, prisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { Repository, Result } from "./repository";

function secretKey(projectId: string, environmentId: string, key: string) {
  return `environmentvariable:${projectId}:${environmentId}:${key}`;
}

export class EnvironmentVariablesRepository implements Repository {
  constructor(private prismaClient: PrismaClient = prisma) {}

  async create(
    projectId: string,
    userId: string,
    options: { key: string; values: { value: string; environmentId: string }[] }
  ): Promise<Result> {
    const project = await this.prismaClient.project.findUnique({
      where: {
        id: projectId,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
        deletedAt: null,
      },
      select: {
        environments: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!project) {
      return { success: false as const, error: "Project not found" };
    }

    if (options.values.every((v) => !project.environments.some((e) => e.id === v.environmentId))) {
      return { success: false as const, error: `Environment not found` };
    }

    //get rid of empty strings
    const values = options.values.filter((v) => v.value.trim() !== "");

    if (values.length === 0) {
      return { success: false as const, error: `All values are empty` };
    }

    try {
      const result = await $transaction(this.prismaClient, async (tx) => {
        const environmentVariable = await tx.environmentVariable.create({
          data: {
            key: options.key,
            project: {
              connect: {
                id: projectId,
              },
            },
          },
        });

        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        //create the secret values and references
        for (const value of values) {
          const key = secretKey(projectId, value.environmentId, options.key);

          //create the secret reference
          const secretReference = await tx.secretReference.create({
            data: {
              key,
              provider: "DATABASE",
            },
          });

          const variableValue = await tx.environmentVariableValue.create({
            data: {
              variableId: environmentVariable.id,
              environmentId: value.environmentId,
              valueReferenceId: secretReference.id,
            },
          });

          await secretStore.setSecret<{ secret: string }>(key, {
            secret: value.value,
          });
        }
      });

      return {
        success: true as const,
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : "Something went wrong",
      };
    }
  }
}
