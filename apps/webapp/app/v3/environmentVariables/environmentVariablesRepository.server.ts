import { Prisma, PrismaClient } from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, prisma } from "~/db.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { EnvironmentVariable, ProjectEnvironmentVariable, Repository, Result } from "./repository";

function secretKeyProjectPrefix(projectId: string) {
  return `environmentvariable:${projectId}:`;
}

function secretKeyEnvironmentPrefix(projectId: string, environmentId: string) {
  return `${secretKeyProjectPrefix(projectId)}${environmentId}:`;
}

function secretKey(projectId: string, environmentId: string, key: string) {
  return `${secretKeyEnvironmentPrefix(projectId, environmentId)}${key}`;
}

function parseSecretKey(key: string) {
  const parts = key.split(":");
  return {
    projectId: parts[1],
    environmentId: parts[2],
    key: parts[3],
  };
}

const SecretValue = z.object({ secret: z.string() });

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
            friendlyId: generateFriendlyId("envvar"),
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
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // The error code for unique constraint violation in Prisma is P2002
        if (error.code === "P2002") {
          return {
            success: false as const,
            error: `There's already an environment variable called ${options.key}.`,
          };
        }
      }

      return {
        success: false as const,
        error: error instanceof Error ? error.message : "Something went wrong",
      };
    }
  }

  async edit(
    projectId: string,
    userId: string,
    options: { values: { value: string; environmentId: string }[]; id: string }
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
          where: {
            OR: [
              {
                orgMember: null,
              },
              {
                orgMember: {
                  userId,
                },
              },
            ],
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
    let values = options.values.filter((v) => v.value.trim() !== "");

    //add in empty values for environments that don't have a value
    const environmentIds = project.environments.map((e) => e.id);
    for (const environmentId of environmentIds) {
      if (!values.some((v) => v.environmentId === environmentId)) {
        values.push({
          environmentId,
          value: "",
        });
      }
    }

    const environmentVariable = await this.prismaClient.environmentVariable.findUnique({
      select: {
        id: true,
        key: true,
      },
      where: {
        id: options.id,
      },
    });
    if (!environmentVariable) {
      return { success: false as const, error: "Environment variable not found" };
    }

    try {
      await $transaction(this.prismaClient, async (tx) => {
        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        //create the secret values and references
        for (const value of values) {
          const key = secretKey(projectId, value.environmentId, environmentVariable.key);
          const existingValue = await tx.environmentVariableValue.findUnique({
            where: {
              variableId_environmentId: {
                variableId: environmentVariable.id,
                environmentId: value.environmentId,
              },
            },
          });

          if (existingValue && existingValue.valueReferenceId) {
            if (value.value === "") {
              //delete the value
              await secretStore.deleteSecret(key);
              await tx.secretReference.delete({
                where: {
                  id: existingValue.valueReferenceId,
                },
              });
              await tx.environmentVariableValue.delete({
                where: {
                  variableId_environmentId: {
                    variableId: environmentVariable.id,
                    environmentId: value.environmentId,
                  },
                },
              });
            } else {
              await secretStore.setSecret<{ secret: string }>(key, {
                secret: value.value,
              });
            }
            continue;
          }

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

    const secrets = await secretStore.getSecrets(SecretValue, secretKeyProjectPrefix(projectId));

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

  async getEnvironment(
    projectId: string,
    userId: string,
    environmentId: string
  ): Promise<EnvironmentVariable[]> {
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
          where: {
            id: environmentId,
          },
        },
      },
    });

    if (!project || project.environments.length === 0) {
      return [];
    }

    return this.getEnvironmentVariables(projectId, environmentId);
  }

  async getEnvironmentVariables(
    projectId: string,
    environmentId: string
  ): Promise<EnvironmentVariable[]> {
    const secretStore = getSecretStore("DATABASE", {
      prismaClient: this.prismaClient,
    });

    const secrets = await secretStore.getSecrets(
      SecretValue,
      secretKeyEnvironmentPrefix(projectId, environmentId)
    );

    return secrets.map((secret) => {
      const { key } = parseSecretKey(secret.key);
      return {
        key,
        value: secret.value.secret,
      };
    });
  }

  async delete(projectId: string, userId: string, options: { id: string }): Promise<Result> {
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
          where: {
            OR: [
              {
                orgMember: null,
              },
              {
                orgMember: {
                  userId,
                },
              },
            ],
          },
        },
      },
    });

    if (!project) {
      return { success: false as const, error: "Project not found" };
    }

    const environmentVariable = await this.prismaClient.environmentVariable.findUnique({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            id: true,
            environmentId: true,
          },
        },
      },
      where: {
        id: options.id,
      },
    });
    if (!environmentVariable) {
      return { success: false as const, error: "Environment variable not found" };
    }

    try {
      await $transaction(this.prismaClient, async (tx) => {
        await tx.environmentVariable.delete({
          where: {
            id: options.id,
          },
        });

        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        //create the secret values and references
        for (const value of environmentVariable.values) {
          const key = secretKey(projectId, value.environmentId, environmentVariable.key);
          await secretStore.deleteSecret(key);
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
