import { PrismaClient } from "@trigger.dev/database";
import { $transaction, prisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { EnvironmentVariable, ProjectEnvironmentVariable, Repository, Result } from "./repository";
import { z } from "zod";

function secretKeyProjectPrefix(projectId: string) {
  return `environmentvariable:${projectId}:`;
}

function secretKeyEnvironmentPrefix(projectId: string, environmentId: string) {
  return `${secretKeyProjectPrefix}${environmentId}:`;
}

function secretKey(projectId: string, environmentId: string, key: string) {
  return `${secretKeyEnvironmentPrefix}${key}`;
}

function parseSecretKey(key: string) {
  const parts = key.split(":");
  return {
    projectId: parts[1],
    environmentId: parts[2],
    key: parts[3],
  };
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
      return { success: false as const, error: `You must set at least one value` };
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

  async getProject(projectId: string, userId: string): Promise<ProjectEnvironmentVariable[]> {
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
            type: true,
          },
        },
      },
    });

    if (!project) {
      return [];
    }

    const secretStore = getSecretStore("DATABASE", {
      prismaClient: this.prismaClient,
    });

    const secrets = await secretStore.getSecrets(
      z.object({ secret: z.string() }),
      secretKeyProjectPrefix(projectId)
    );

    const values = secrets.map((secret) => {
      const { projectId, environmentId, key } = parseSecretKey(secret.key);
      return {
        projectId,
        environmentId,
        key,
        value: secret.value.secret,
      };
    });

    //now group the values together by key and environment ID into ProjectEnvironmentVariable[]
    //and add the type of environment to the result
    const results: ProjectEnvironmentVariable[] = [];
    for (const value of values) {
      const environment = project.environments.find((e) => e.id === value.environmentId);
      if (!environment) {
        throw new Error("Environment not found");
      }

      const existing = results.find((r) => r.key === value.key);
      if (existing) {
        existing.values.push({
          value: value.value,
          environment: {
            id: value.environmentId,
            type: environment.type,
          },
        });
      } else {
        results.push({
          key: value.key,
          values: [
            {
              value: value.value,
              environment: {
                id: value.environmentId,
                type: environment.type,
              },
            },
          ],
        });
      }
    }

    return results;
  }

  getEnvironment(
    projectId: string,
    userId: string,
    environmentId: string
  ): Promise<EnvironmentVariable[]> {
    throw new Error("Method not implemented.");
  }
}
