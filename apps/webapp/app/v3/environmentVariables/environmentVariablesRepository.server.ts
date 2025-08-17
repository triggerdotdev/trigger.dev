import { Prisma, type PrismaClient, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import {
  type CreateResult,
  type DeleteEnvironmentVariable,
  type DeleteEnvironmentVariableValue,
  type EnvironmentVariable,
  type EnvironmentVariableWithSecret,
  type ProjectEnvironmentVariable,
  type Repository,
  type Result,
} from "./repository";
import { removeBlacklistedVariables } from "../environmentVariableRules.server";
import { deduplicateVariableArray } from "../deduplicateVariableArray.server";
import { logger } from "~/services/logger.server";

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
    options: {
      override: boolean;
      environmentIds: string[];
      isSecret?: boolean;
      variables: {
        key: string;
        value: string;
      }[];
    }
  ): Promise<CreateResult> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      select: {
        environments: {
          select: {
            id: true,
          },
        },
        environmentVariables: {
          select: {
            key: true,
            values: {
              select: {
                environment: {
                  select: { id: true, type: true },
                },
              },
            },
          },
        },
      },
    });

    if (!project) {
      return { success: false as const, error: "Project not found" };
    }

    if (options.environmentIds.every((v) => !project.environments.some((e) => e.id === v))) {
      return { success: false as const, error: `Environment not found` };
    }

    // Remove `TRIGGER_SECRET_KEY` or `TRIGGER_API_URL`
    let values = removeBlacklistedVariables(options.variables);
    const removedBlacklisted = values.length !== options.variables.length;

    //get rid of empty variables
    values = values.filter((v) => v.key.trim() !== "" && v.value.trim() !== "");
    if (values.length === 0) {
      return {
        success: false as const,
        error: `You must set at least one valid variable.${
          removedBlacklisted ? " All the variables submitted are not allowed." : ""
        }`,
      };
    }

    //check if any of them exist in an environment we're setting
    if (!options.override) {
      const existingVariableKeys: { key: string; environments: RuntimeEnvironmentType[] }[] = [];
      for (const variable of values) {
        const existingVariable = project.environmentVariables.find((v) => v.key === variable.key);
        if (
          existingVariable &&
          existingVariable.values.some((v) => options.environmentIds.includes(v.environment.id))
        ) {
          existingVariableKeys.push({
            key: variable.key,
            environments: existingVariable.values
              .filter((v) => options.environmentIds.includes(v.environment.id))
              .map((v) => v.environment.type),
          });
        }
      }

      if (existingVariableKeys.length > 0) {
        return {
          success: false as const,
          error: `Some of the variables are already set for these environments. Set override to true to override them.`,
          variableErrors: existingVariableKeys.map((val) => ({
            key: val.key,
            error: `Variable already set in ${val.environments
              .map((e) => environmentFullTitle({ type: e }))
              .join(", ")}.`,
          })),
        };
      }
    }

    try {
      for (const variable of values) {
        const result = await $transaction(this.prismaClient, "create env var", async (tx) => {
          const environmentVariable = await tx.environmentVariable.upsert({
            where: {
              projectId_key: {
                key: variable.key,
                projectId,
              },
            },
            create: {
              key: variable.key,
              friendlyId: generateFriendlyId("envvar"),
              project: {
                connect: {
                  id: projectId,
                },
              },
            },
            update: {},
          });

          const secretStore = getSecretStore("DATABASE", {
            prismaClient: tx,
          });

          //set the secret values and references
          for (const environmentId of options.environmentIds) {
            const key = secretKey(projectId, environmentId, variable.key);

            //create the secret reference
            const secretReference = await tx.secretReference.upsert({
              where: {
                key,
              },
              create: {
                key,
                provider: "DATABASE",
              },
              update: {},
            });

            const variableValue = await tx.environmentVariableValue.upsert({
              where: {
                variableId_environmentId: {
                  variableId: environmentVariable.id,
                  environmentId,
                },
              },
              create: {
                variableId: environmentVariable.id,
                environmentId: environmentId,
                valueReferenceId: secretReference.id,
                isSecret: options.isSecret,
              },
              update: {
                isSecret: options.isSecret,
              },
            });

            await secretStore.setSecret<{ secret: string }>(key, {
              secret: variable.value,
            });
          }
        });
      }

      return {
        success: true as const,
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // The error code for unique constraint violation in Prisma is P2002
        if (error.code === "P2002") {
          return {
            success: false as const,
            error: `There was already an existing field`,
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
    options: {
      values: { value: string; environmentId: string }[];
      id: string;
      keepEmptyValues?: boolean;
    }
  ): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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
    let values = options.values.filter((v) => v.value.trim() !== "");

    //add in empty values for environments that don't have a value
    const environmentIds = project.environments.map((e) => e.id);

    if (!options.keepEmptyValues) {
      for (const environmentId of environmentIds) {
        if (!values.some((v) => v.environmentId === environmentId)) {
          values.push({
            environmentId,
            value: "",
          });
        }
      }
    }

    const environmentVariable = await this.prismaClient.environmentVariable.findFirst({
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
      await $transaction(this.prismaClient, "edit env var", async (tx) => {
        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        //create the secret values and references
        for (const value of values) {
          const key = secretKey(projectId, value.environmentId, environmentVariable.key);
          const existingValue = await tx.environmentVariableValue.findFirst({
            where: {
              variableId: environmentVariable.id,
              environmentId: value.environmentId,
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

  async editValue(
    projectId: string,
    options: {
      id: string;
      environmentId: string;
      value: string;
    }
  ): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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

    if (!project.environments.some((e) => e.id === options.environmentId)) {
      return { success: false as const, error: "Environment not found" };
    }

    const environmentVariable = await this.prismaClient.environmentVariable.findFirst({
      select: {
        id: true,
        key: true,
        values: {
          where: {
            environmentId: options.environmentId,
          },
          select: {
            valueReferenceId: true,
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

    if (environmentVariable.values.length === 0) {
      return { success: false as const, error: "Environment variable value not found" };
    }

    try {
      await $transaction(this.prismaClient, "edit env var value", async (tx) => {
        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        const key = secretKey(projectId, options.environmentId, environmentVariable.key);
        await secretStore.setSecret<{ secret: string }>(key, {
          secret: options.value,
        });
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

  async getProject(projectId: string): Promise<ProjectEnvironmentVariable[]> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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

  async getEnvironmentWithRedactedSecrets(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string
  ): Promise<EnvironmentVariableWithSecret[]> {
    const variables = await this.getEnvironment(projectId, environmentId, parentEnvironmentId);

    // Get the keys of all secret variables
    const secretValues = await this.prismaClient.environmentVariableValue.findMany({
      where: {
        environmentId: parentEnvironmentId
          ? { in: [environmentId, parentEnvironmentId] }
          : environmentId,
        isSecret: true,
      },
      select: {
        variable: {
          select: {
            key: true,
          },
        },
      },
    });
    const secretVarKeys = secretValues.map((r) => r.variable.key);

    // Filter out secret variables
    return variables.map((v) => {
      if (secretVarKeys.includes(v.key)) {
        return {
          key: v.key,
          value: "<redacted>",
          isSecret: true,
        };
      }

      return { key: v.key, value: v.value, isSecret: false };
    });
  }

  async getEnvironment(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string
  ): Promise<EnvironmentVariable[]> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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

    return this.getEnvironmentVariables(projectId, environmentId, parentEnvironmentId);
  }

  async #getSecretEnvironmentVariables(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string
  ): Promise<EnvironmentVariable[]> {
    const secretStore = getSecretStore("DATABASE", {
      prismaClient: this.prismaClient,
    });

    const parentSecrets = parentEnvironmentId
      ? await secretStore.getSecrets(
          SecretValue,
          secretKeyEnvironmentPrefix(projectId, parentEnvironmentId)
        )
      : [];

    const childSecrets = await secretStore.getSecrets(
      SecretValue,
      secretKeyEnvironmentPrefix(projectId, environmentId)
    );

    // Merge the secrets, we want child ones to override parent ones
    const mergedSecrets = new Map<string, string>();
    for (const secret of parentSecrets) {
      const { key: parsedKey } = parseSecretKey(secret.key);
      mergedSecrets.set(parsedKey, secret.value.secret);
    }
    for (const secret of childSecrets) {
      const { key: parsedKey } = parseSecretKey(secret.key);
      mergedSecrets.set(parsedKey, secret.value.secret);
    }

    const merged = Array.from(mergedSecrets.entries()).map(([key, value]) => {
      return {
        key,
        value,
      };
    });

    return removeBlacklistedVariables(merged);
  }

  async getEnvironmentVariables(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string
  ): Promise<EnvironmentVariable[]> {
    return this.#getSecretEnvironmentVariables(projectId, environmentId, parentEnvironmentId);
  }

  async delete(projectId: string, options: DeleteEnvironmentVariable): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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

    const environmentVariable = await this.prismaClient.environmentVariable.findFirst({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            id: true,
            environmentId: true,
            valueReference: {
              select: {
                key: true,
              },
            },
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
      await $transaction(this.prismaClient, "delete env var", async (tx) => {
        await tx.environmentVariable.delete({
          where: {
            id: options.id,
          },
        });

        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        //delete the secret values and references
        for (const value of environmentVariable.values) {
          const key = secretKey(projectId, value.environmentId, environmentVariable.key);
          await secretStore.deleteSecret(key);

          if (value.valueReference) {
            await tx.secretReference.delete({
              where: {
                key: value.valueReference.key,
              },
            });
          }
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

  async deleteValue(projectId: string, options: DeleteEnvironmentVariableValue): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
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

    const environmentVariable = await this.prismaClient.environmentVariable.findFirst({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            id: true,
            environmentId: true,
            valueReference: {
              select: {
                key: true,
              },
            },
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

    const value = environmentVariable.values.find((v) => v.environmentId === options.environmentId);

    if (!value) {
      return { success: false as const, error: "Environment variable value not found" };
    }

    // If this is the last value, delete the whole variable
    if (environmentVariable.values.length === 1) {
      return this.delete(projectId, { id: options.id });
    }

    try {
      await $transaction(this.prismaClient, "delete env var value", async (tx) => {
        const secretStore = getSecretStore("DATABASE", {
          prismaClient: tx,
        });

        const key = secretKey(projectId, options.environmentId, environmentVariable.key);
        await secretStore.deleteSecret(key);

        if (value.valueReference) {
          await tx.secretReference.delete({
            where: {
              key: value.valueReference.key,
            },
          });
        }

        await tx.environmentVariableValue.delete({
          where: {
            id: value.id,
          },
        });
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

export const RuntimeEnvironmentForEnvRepoPayload = {
  select: {
    id: true,
    slug: true,
    type: true,
    projectId: true,
    apiKey: true,
    organizationId: true,
    branchName: true,
    builtInEnvironmentVariableOverrides: true,
  },
} as const;

export type RuntimeEnvironmentForEnvRepo = Prisma.RuntimeEnvironmentGetPayload<
  typeof RuntimeEnvironmentForEnvRepoPayload
>;

export const environmentVariablesRepository = new EnvironmentVariablesRepository();

export async function resolveVariablesForEnvironment(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo
) {
  const projectSecrets = await environmentVariablesRepository.getEnvironmentVariables(
    runtimeEnvironment.projectId,
    runtimeEnvironment.id,
    parentEnvironment?.id
  );

  const overridableTriggerVariables = await resolveOverridableTriggerVariables(runtimeEnvironment);

  const builtInVariables =
    runtimeEnvironment.type === "DEVELOPMENT"
      ? await resolveBuiltInDevVariables(runtimeEnvironment)
      : await resolveBuiltInProdVariables(runtimeEnvironment, parentEnvironment);

  const overridableOtelVariables =
    runtimeEnvironment.type === "DEVELOPMENT"
      ? await resolveOverridableOtelDevVariables(runtimeEnvironment)
      : [];

  const result = deduplicateVariableArray([
    ...overridableTriggerVariables,
    ...overridableOtelVariables,
    ...projectSecrets,
    ...builtInVariables,
  ]);

  return result;
}

async function resolveOverridableTriggerVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo
) {
  let result: Array<EnvironmentVariable> = [
    {
      key: "TRIGGER_REALTIME_STREAM_VERSION",
      value: env.REALTIME_STREAM_VERSION,
    },
  ];

  return result;
}

async function resolveBuiltInDevVariables(runtimeEnvironment: RuntimeEnvironmentForEnvRepo) {
  let result: Array<EnvironmentVariable> = [
    {
      key: "TRIGGER_OTEL_EXPORTER_OTLP_ENDPOINT",
      value: env.DEV_OTEL_EXPORTER_OTLP_ENDPOINT ?? `${env.APP_ORIGIN.replace(/\/$/, "")}/otel`,
    },
    {
      key: "TRIGGER_API_URL",
      value: env.API_ORIGIN ?? env.APP_ORIGIN,
    },
    {
      key: "TRIGGER_STREAM_URL",
      value: env.STREAM_ORIGIN ?? env.API_ORIGIN ?? env.APP_ORIGIN,
    },
  ];

  if (env.DEV_OTEL_BATCH_PROCESSING_ENABLED === "1") {
    result = result.concat([
      {
        key: "TRIGGER_OTEL_BATCH_PROCESSING_ENABLED",
        value: "1",
      },
      {
        key: "TRIGGER_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE",
        value: env.DEV_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "TRIGGER_OTEL_SPAN_SCHEDULED_DELAY_MILLIS",
        value: env.DEV_OTEL_SPAN_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS",
        value: env.DEV_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_SPAN_MAX_QUEUE_SIZE",
        value: env.DEV_OTEL_SPAN_MAX_QUEUE_SIZE,
      },
      {
        key: "TRIGGER_OTEL_LOG_MAX_EXPORT_BATCH_SIZE",
        value: env.DEV_OTEL_LOG_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "TRIGGER_OTEL_LOG_SCHEDULED_DELAY_MILLIS",
        value: env.DEV_OTEL_LOG_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_LOG_EXPORT_TIMEOUT_MILLIS",
        value: env.DEV_OTEL_LOG_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_LOG_MAX_QUEUE_SIZE",
        value: env.DEV_OTEL_LOG_MAX_QUEUE_SIZE,
      },
      {
        key: "OTEL_BATCH_PROCESSING_ENABLED",
        value: "1",
      },
      {
        key: "OTEL_SPAN_MAX_EXPORT_BATCH_SIZE",
        value: env.DEV_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "OTEL_SPAN_SCHEDULED_DELAY_MILLIS",
        value: env.DEV_OTEL_SPAN_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "OTEL_SPAN_EXPORT_TIMEOUT_MILLIS",
        value: env.DEV_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "OTEL_SPAN_MAX_QUEUE_SIZE",
        value: env.DEV_OTEL_SPAN_MAX_QUEUE_SIZE,
      },
      {
        key: "OTEL_LOG_MAX_EXPORT_BATCH_SIZE",
        value: env.DEV_OTEL_LOG_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "OTEL_LOG_SCHEDULED_DELAY_MILLIS",
        value: env.DEV_OTEL_LOG_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "OTEL_LOG_EXPORT_TIMEOUT_MILLIS",
        value: env.DEV_OTEL_LOG_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "OTEL_LOG_MAX_QUEUE_SIZE",
        value: env.DEV_OTEL_LOG_MAX_QUEUE_SIZE,
      },
    ]);
  }

  const commonVariables = await resolveCommonBuiltInVariables(runtimeEnvironment);

  return [...result, ...commonVariables];
}

async function resolveOverridableOtelDevVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo
) {
  let result: Array<EnvironmentVariable> = [
    {
      key: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: env.DEV_OTEL_EXPORTER_OTLP_ENDPOINT ?? `${env.APP_ORIGIN.replace(/\/$/, "")}/otel`,
    },
  ];

  return result;
}

async function resolveBuiltInProdVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo
) {
  let result: Array<EnvironmentVariable> = [
    {
      key: "TRIGGER_SECRET_KEY",
      value: parentEnvironment?.apiKey ?? runtimeEnvironment.apiKey,
    },
    {
      key: "TRIGGER_API_URL",
      value: env.API_ORIGIN ?? env.APP_ORIGIN,
    },
    {
      key: "TRIGGER_STREAM_URL",
      value: env.STREAM_ORIGIN ?? env.API_ORIGIN ?? env.APP_ORIGIN,
    },
    {
      key: "TRIGGER_RUNTIME_WAIT_THRESHOLD_IN_MS",
      value: String(env.CHECKPOINT_THRESHOLD_IN_MS),
    },
    {
      key: "TRIGGER_ORG_ID",
      value: runtimeEnvironment.organizationId,
    },
  ];

  if (runtimeEnvironment.branchName) {
    result = result.concat([
      {
        key: "TRIGGER_PREVIEW_BRANCH",
        value: runtimeEnvironment.branchName,
      },
    ]);
  }

  if (env.PROD_OTEL_BATCH_PROCESSING_ENABLED === "1") {
    result = result.concat([
      {
        key: "TRIGGER_OTEL_BATCH_PROCESSING_ENABLED",
        value: "1",
      },
      {
        key: "TRIGGER_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE",
        value: env.PROD_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "TRIGGER_OTEL_SPAN_SCHEDULED_DELAY_MILLIS",
        value: env.PROD_OTEL_SPAN_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS",
        value: env.PROD_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_SPAN_MAX_QUEUE_SIZE",
        value: env.PROD_OTEL_SPAN_MAX_QUEUE_SIZE,
      },
      {
        key: "TRIGGER_OTEL_LOG_MAX_EXPORT_BATCH_SIZE",
        value: env.PROD_OTEL_LOG_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "TRIGGER_OTEL_LOG_SCHEDULED_DELAY_MILLIS",
        value: env.PROD_OTEL_LOG_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_LOG_EXPORT_TIMEOUT_MILLIS",
        value: env.PROD_OTEL_LOG_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "TRIGGER_OTEL_LOG_MAX_QUEUE_SIZE",
        value: env.PROD_OTEL_LOG_MAX_QUEUE_SIZE,
      },
      {
        key: "OTEL_BATCH_PROCESSING_ENABLED",
        value: "1",
      },
      {
        key: "OTEL_SPAN_MAX_EXPORT_BATCH_SIZE",
        value: env.PROD_OTEL_SPAN_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "OTEL_SPAN_SCHEDULED_DELAY_MILLIS",
        value: env.PROD_OTEL_SPAN_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "OTEL_SPAN_EXPORT_TIMEOUT_MILLIS",
        value: env.PROD_OTEL_SPAN_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "OTEL_SPAN_MAX_QUEUE_SIZE",
        value: env.PROD_OTEL_SPAN_MAX_QUEUE_SIZE,
      },
      {
        key: "OTEL_LOG_MAX_EXPORT_BATCH_SIZE",
        value: env.PROD_OTEL_LOG_MAX_EXPORT_BATCH_SIZE,
      },
      {
        key: "OTEL_LOG_SCHEDULED_DELAY_MILLIS",
        value: env.PROD_OTEL_LOG_SCHEDULED_DELAY_MILLIS,
      },
      {
        key: "OTEL_LOG_EXPORT_TIMEOUT_MILLIS",
        value: env.PROD_OTEL_LOG_EXPORT_TIMEOUT_MILLIS,
      },
      {
        key: "OTEL_LOG_MAX_QUEUE_SIZE",
        value: env.PROD_OTEL_LOG_MAX_QUEUE_SIZE,
      },
    ]);
  }

  if (env.PROD_USAGE_HEARTBEAT_INTERVAL_MS && env.USAGE_EVENT_URL) {
    result = result.concat([
      {
        key: "USAGE_HEARTBEAT_INTERVAL_MS",
        value: String(env.PROD_USAGE_HEARTBEAT_INTERVAL_MS),
      },
      {
        key: "USAGE_EVENT_URL",
        value: env.USAGE_EVENT_URL,
      },
    ]);
  }

  if (env.PROD_TASK_HEARTBEAT_INTERVAL_MS) {
    result = result.concat([
      {
        key: "HEARTBEAT_INTERVAL_MS",
        value: String(env.PROD_TASK_HEARTBEAT_INTERVAL_MS),
      },
    ]);
  }

  const commonVariables = await resolveCommonBuiltInVariables(runtimeEnvironment);

  return [...result, ...commonVariables];
}

async function resolveCommonBuiltInVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo
): Promise<Array<EnvironmentVariable>> {
  return [
    {
      key: "TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_LOG_ATTRIBUTE_COUNT_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_LOG_ATTRIBUTE_VALUE_LENGTH_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_SPAN_EVENT_COUNT_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_LINK_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_LINK_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_LINK_COUNT_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_ATTRIBUTE_PER_LINK_COUNT_LIMIT)
      ),
    },
    {
      key: "TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
        runtimeEnvironment,
        String(env.TRIGGER_OTEL_ATTRIBUTE_PER_EVENT_COUNT_LIMIT)
      ),
    },
  ];
}

function resolveBuiltInEnvironmentVariableOverrides(
  key: string,
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  defaultValue: string
) {
  const overrides = runtimeEnvironment.builtInEnvironmentVariableOverrides;

  if (!overrides) {
    return defaultValue;
  }

  if (
    !Array.isArray(overrides) &&
    typeof overrides === "object" &&
    key in overrides &&
    typeof overrides[key] === "string"
  ) {
    return overrides[key];
  }

  return defaultValue;
}
