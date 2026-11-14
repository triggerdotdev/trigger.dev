import { EnvironmentKeyUnavailableError } from "~/services/environmentEncryption/wrapping.server";
import {
  EMPTY_ENV_VALUES_DISABLED,
  emptyEnvironmentVariableValuesEnabled,
} from "./emptyValuesFlag.server";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import {
  boundedIn,
  Prisma,
  type PrismaClient,
  type EnvironmentEncryptionPolicy,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { z } from "zod";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import {
  $replica,
  $transaction,
  prisma,
  type PrismaReplicaClient,
  type PrismaClientOrTransaction,
} from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  effectiveEnvironmentVariables,
  assertVariablesNotProxyOnly,
} from "~/services/secretProxy/variables.server";
import { environmentEncryption } from "~/services/environmentEncryption/instance.server";
import { secretProxyEnabled } from "~/services/secretProxy/featureFlag.server";
import {
  EnvironmentSecretStore,
  protectedSecretKeys,
} from "~/services/environmentEncryption/secretStore.server";
import type {
  EnvironmentEncryptionService,
  PreparedEnvironmentWrite,
} from "~/services/environmentEncryption/service.server";
import { deduplicateVariableArray } from "../deduplicateVariableArray.server";
import {
  isBlacklistedVariable,
  removeBlacklistedVariables,
} from "../environmentVariableRules.server";
import { FEATURE_FLAG, resolveInternalApiOriginEnabled } from "../featureFlags";
import { globalFlagsRegistry } from "../globalFlagsRegistry.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import {
  type CreateEnvironmentVariables,
  type CreateResult,
  type DeleteEnvironmentVariableValue,
  type DeleteValuesResult,
  type CopyEnvironmentVariableValues,
  type CopyValuesResult,
  type EnvironmentVariableUpdater,
  type EditEnvironmentVariable,
  type EditEnvironmentVariableValue,
  type EnvironmentVariable,
  type EnvironmentVariableWithSecret,
  type ProjectEnvironmentVariable,
  type Repository,
  type Result,
} from "./repository";

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

/**
 * What a caller is told when a write throws. An error from the database never reaches them as
 * text (it names tables, constraints and source lines): it is logged here and replaced with a
 * sentence. Errors raised by this app keep their own message.
 */
function writeFailure(error: unknown, operation: string, projectId: string) {
  if (!(error instanceof Error) || !error.name.startsWith("PrismaClient")) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "Something went wrong",
    };
  }

  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  // P2003 and P2025: a row this write depends on was deleted under it, in practice the variable
  // or the value, by a delete that committed first. P2002: another request wrote the same row.
  if (code === "P2003" || code === "P2025" || code === "P2002") {
    logger.warn("Environment variable write lost to a concurrent change", {
      operation,
      projectId,
      error,
    });
    return {
      success: false as const,
      conflict: true as const,
      error:
        code === "P2002"
          ? "This environment variable was changed by someone else while your change was being saved. Try again."
          : "This environment variable was deleted while your change was being saved. Try again.",
    };
  }

  logger.error("Environment variable write failed", { operation, projectId, error });
  return {
    success: false as const,
    error: "Something went wrong and your change wasn't saved. Try again.",
  };
}

export class EnvironmentVariablesRepository implements Repository {
  #encryption?: EnvironmentEncryptionService;

  constructor(
    private prismaClient: PrismaClient = prisma,
    private replicaClient: PrismaReplicaClient = $replica,
    encryption?: EnvironmentEncryptionService,
    /** Whether each client reads through the pg driver adapter, where the raw secret read is faster. */
    private driverAdapter = {
      writer: env.CONTROL_PLANE_DATABASE_WRITER_DRIVER_ADAPTER === "1",
      replica: env.CONTROL_PLANE_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
    }
  ) {
    this.#encryption = encryption;
  }

  private get encryption() {
    return (this.#encryption ??= environmentEncryption(this.prismaClient));
  }

  #secretStore(
    db: PrismaClientOrTransaction,
    projectId: string,
    environmentIds: string[],
    prepared?: Map<string, PreparedEnvironmentWrite>,
    protectedKeys?: ReadonlySet<string>
  ) {
    // A transaction runs on the writer. When there is no separate replica, both are the writer.
    const rawReads =
      db !== this.prismaClient && db === this.replicaClient
        ? this.driverAdapter.replica
        : this.driverAdapter.writer;
    return new EnvironmentSecretStore(
      db,
      this.encryption,
      projectId,
      environmentIds,
      prepared,
      protectedKeys,
      rawReads
    );
  }

  async #prepareWrites(
    projectId: string,
    environments: Array<{
      id: string;
      encryptionPolicy: Pick<EnvironmentEncryptionPolicy, "activeKeyId" | "revision"> | null;
    }>
  ) {
    return new Map(
      await Promise.all(
        environments.map(
          async (environment) =>
            [
              environment.id,
              await this.encryption.prepareWrite(
                { projectId, environmentId: environment.id },
                environment.encryptionPolicy
              ),
            ] as const
        )
      )
    );
  }

  /**
   * Writes one variable's value to each of the environments, inside the caller's transaction: the
   * save path of `create` and `copyValues`. `isSecret` set changes the kind of an existing value;
   * left out, an existing value keeps its kind and a new one takes its parent environment's.
   * Returns, per environment, whether the value was new there.
   */
  async #writeVariable(
    tx: PrismaClientOrTransaction,
    projectId: string,
    {
      key: variableKey,
      value,
      environmentIds,
      isSecret,
      parentEnvironmentId,
      lastUpdatedBy,
      prepared,
      unchanged,
    }: {
      key: string;
      value: string;
      environmentIds: string[];
      isSecret?: boolean;
      parentEnvironmentId?: string;
      lastUpdatedBy?: EnvironmentVariableUpdater;
      prepared: Map<string, PreparedEnvironmentWrite>;
      /** Whether an existing value is left as it is, because it already holds this value. */
      unchanged?: (
        environmentId: string,
        existing: { id: string; version: number; isSecret: boolean }
      ) => boolean;
    }
  ): Promise<Map<string, { created: boolean }>> {
    const written = new Map<string, { created: boolean }>();
    const environmentVariable = await tx.environmentVariable.upsert({
      where: {
        projectId_key: {
          key: variableKey,
          projectId,
        },
      },
      create: {
        key: variableKey,
        friendlyId: generateFriendlyId("envvar"),
        project: {
          connect: {
            id: projectId,
          },
        },
      },
      update: {},
    });

    const secretStore = this.#secretStore(tx, projectId, environmentIds, prepared, new Set());

    // If parentEnvironmentId is provided and isSecret is not explicitly set,
    // look up if the parent has this variable marked as secret
    let inheritedIsSecret: boolean | undefined = undefined;
    if (isSecret === undefined && parentEnvironmentId) {
      const parentVariableValue = await tx.environmentVariableValue.findFirst({
        where: {
          variableId: environmentVariable.id,
          environmentId: parentEnvironmentId,
        },
        select: {
          isSecret: true,
        },
      });
      if (parentVariableValue?.isSecret) {
        inheritedIsSecret = true;
      }
    }

    const effectiveIsSecret = isSecret ?? inheritedIsSecret;

    //set the secret values and references
    for (const environmentId of environmentIds) {
      const key = secretKey(projectId, environmentId, variableKey);

      const existingValueRecord = await tx.environmentVariableValue.findFirst({
        where: {
          variableId: environmentVariable.id,
          environmentId,
        },
      });

      // Check if value already exists and is the same, and no metadata change (e.g. isSecret toggle)
      if (existingValueRecord && unchanged?.(environmentId, existingValueRecord)) {
        continue;
      }

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

      if (existingValueRecord) {
        await tx.environmentVariableValue.update({
          where: {
            id: existingValueRecord.id,
          },
          data: {
            version: {
              increment: 1,
            },
            ...(lastUpdatedBy ? { lastUpdatedBy } : {}),
            valueReferenceId: secretReference.id,
            ...(isSecret !== undefined ? { isSecret } : {}),
          },
        });
      } else {
        await tx.environmentVariableValue.create({
          data: {
            variableId: environmentVariable.id,
            environmentId: environmentId,
            valueReferenceId: secretReference.id,
            isSecret: effectiveIsSecret,
            version: 1,
            lastUpdatedBy: lastUpdatedBy ? lastUpdatedBy : Prisma.JsonNull,
          },
        });
      }

      await secretStore.setSecret<{ secret: string }>(key, { secret: value });
      written.set(environmentId, { created: !existingValueRecord });
    }

    return written;
  }

  async create(projectId: string, options: CreateEnvironmentVariables): Promise<CreateResult> {
    if (options.environmentIds.length === 0) {
      return { success: false as const, error: "At least one environment is required" };
    }

    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      select: {
        organization: { select: { featureFlags: true } },
        environments: {
          where: { id: { in: boundedIn(options.environmentIds) } },
          select: {
            id: true,
            encryptionPolicy: { select: { activeKeyId: true, revision: true } },
          },
        },
        environmentVariables: {
          where: {
            key: { in: boundedIn(options.variables.map((v) => v.key)) },
          },
          select: {
            key: true,
            values: {
              where: {
                environmentId: { in: boundedIn(options.environmentIds) },
              },
              select: {
                id: true,
                version: true,
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

    // Reject if ANY supplied environmentId is outside the caller's project.
    // `.some` (not `.every`) so one in-project id can't let a mixed array
    // through.
    if (options.environmentIds.some((v) => !project.environments.some((e) => e.id === v))) {
      return { success: false as const, error: `Environment not found` };
    }

    // Remove `TRIGGER_SECRET_KEY` or `TRIGGER_API_URL`
    let values = removeBlacklistedVariables(options.variables);
    const removedBlacklisted = values.length !== options.variables.length;

    //get rid of variables with an empty key (an empty value is a valid value)
    values = values.filter((v) => v.key.trim() !== "");
    if (
      values.some((v) => v.value.trim() === "") &&
      // Resolve the existing flag first, preserving its reads and failure behavior.
      (!(await emptyEnvironmentVariableValuesEnabled(
        project.organization.featureFlags,
        this.prismaClient
      )) ||
        (options.lastUpdatedBy?.type === "integration" &&
          options.lastUpdatedBy.integration === "vercel"))
    ) {
      values = values.filter((v) => v.value.trim() !== "");
      // Automated sync must remain a no-op when every supplied value is disabled.
      if (
        values.length === 0 &&
        options.lastUpdatedBy?.type === "integration" &&
        !removedBlacklisted
      ) {
        return { success: true as const };
      }
    }
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
      const prepared = await this.#prepareWrites(projectId, project.environments);
      const proxyEnabled = secretProxyEnabled(project.organization.featureFlags);
      const existingSecrets = new Map(
        (
          await this.#secretStore(
            this.prismaClient,
            projectId,
            options.environmentIds,
            undefined,
            proxyEnabled ? undefined : new Set()
          ).getSecretsByKeys(
            SecretValue,
            values.flatMap((v) =>
              options.environmentIds.map((id) => secretKey(projectId, id, v.key))
            )
          )
        ).map((secret) => [secret.key, secret.value])
      );
      for (const variable of values) {
        const _result = await $transaction(this.prismaClient, "create env var", async (tx) => {
          if (proxyEnabled) {
            await assertVariablesNotProxyOnly(tx, projectId, options.environmentIds, [
              variable.key,
            ]);
          }
          await this.encryption.assertWrite(tx, [...prepared.values()]);
          await this.#writeVariable(tx, projectId, {
            key: variable.key,
            value: variable.value,
            environmentIds: options.environmentIds,
            isSecret: options.isSecret,
            parentEnvironmentId: options.parentEnvironmentId,
            lastUpdatedBy: options.lastUpdatedBy,
            prepared,
            // Left as it is when it already holds this value, unchanged since it was read above.
            unchanged: (environmentId, existingValueRecord) => {
              const existingSecret = existingSecrets.get(
                secretKey(projectId, environmentId, variable.key)
              );
              const previousValue = project.environmentVariables
                .find((v) => v.key === variable.key)
                ?.values.find((v) => v.environment.id === environmentId);
              return Boolean(
                existingSecret &&
                existingSecret.secret === variable.value &&
                existingValueRecord.id === previousValue?.id &&
                existingValueRecord.version === previousValue.version &&
                (options.isSecret === undefined ||
                  existingValueRecord.isSecret === options.isSecret)
              );
            },
          });
        });
      }

      return {
        success: true as const,
      };
    } catch (error) {
      return writeFailure(error, "create", projectId);
    }
  }

  async edit(projectId: string, options: EditEnvironmentVariable): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      select: {
        organization: { select: { featureFlags: true } },
        environments: {
          where: { id: { in: boundedIn(options.values.map((value) => value.environmentId)) } },
          select: {
            id: true,
            encryptionPolicy: { select: { activeKeyId: true, revision: true } },
          },
        },
      },
    });

    if (!project) {
      return { success: false as const, error: "Project not found" };
    }

    // Same guard as `create()`: reject if ANY supplied environmentId is
    // outside the caller's project (`.some`, not `.every`).
    if (options.values.some((v) => !project.environments.some((e) => e.id === v.environmentId))) {
      return { success: false as const, error: `Environment not found` };
    }

    // An empty string is a valid, distinct value stored verbatim, never
    // treated as "absent" or "delete". Removal is a separate operation.
    if (
      options.values.some((v) => v.value.trim() === "") &&
      !(await emptyEnvironmentVariableValuesEnabled(
        project.organization.featureFlags,
        this.prismaClient
      ))
    ) {
      return { success: false as const, error: EMPTY_ENV_VALUES_DISABLED };
    }
    const values = options.values;

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
      const prepared = await this.#prepareWrites(projectId, project.environments);
      const proxyEnabled = secretProxyEnabled(project.organization.featureFlags);
      await $transaction(this.prismaClient, "edit env var", async (tx) => {
        if (proxyEnabled) {
          await assertVariablesNotProxyOnly(
            tx,
            projectId,
            values.map((value) => value.environmentId),
            [environmentVariable.key]
          );
        }
        await this.encryption.assertWrite(tx, [...prepared.values()]);
        const secretStore = this.#secretStore(
          tx,
          projectId,
          [...prepared.keys()],
          prepared,
          new Set()
        );

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
            await secretStore.setSecret<{ secret: string }>(key, {
              secret: value.value,
            });
            await tx.environmentVariableValue.update({
              where: {
                variableId_environmentId: {
                  variableId: environmentVariable.id,
                  environmentId: value.environmentId,
                },
              },
              data: {
                version: {
                  increment: 1,
                },
                lastUpdatedBy: options.lastUpdatedBy ? options.lastUpdatedBy : undefined,
              },
            });
            continue;
          }

          //create the secret reference
          const secretReference = await tx.secretReference.create({
            data: {
              key,
              provider: "DATABASE",
            },
          });

          const _variableValue = await tx.environmentVariableValue.create({
            data: {
              variableId: environmentVariable.id,
              environmentId: value.environmentId,
              valueReferenceId: secretReference.id,
              version: 1,
              lastUpdatedBy: options.lastUpdatedBy ? options.lastUpdatedBy : Prisma.JsonNull,
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
      return writeFailure(error, "edit", projectId);
    }
  }

  async editValue(projectId: string, options: EditEnvironmentVariableValue): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      select: {
        organization: { select: { featureFlags: true } },
        environments: {
          where: { id: options.environmentId },
          select: {
            id: true,
            encryptionPolicy: { select: { activeKeyId: true, revision: true } },
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
            isSecret: true,
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

    const value = options.setEmptyValue === "true" ? "" : options.value;
    if (
      value.trim() === "" &&
      !(await emptyEnvironmentVariableValuesEnabled(
        project.organization.featureFlags,
        this.prismaClient
      ))
    ) {
      return { success: false as const, error: EMPTY_ENV_VALUES_DISABLED };
    }
    if (
      environmentVariable.values[0].isSecret &&
      value === "" &&
      options.setEmptyValue !== "true"
    ) {
      return {
        success: false as const,
        error: 'Enter a new secret value or select "Set to an empty string".',
      };
    }

    try {
      const prepared = await this.#prepareWrites(projectId, project.environments);
      const proxyEnabled = secretProxyEnabled(project.organization.featureFlags);
      await $transaction(this.prismaClient, "edit env var value", async (tx) => {
        if (proxyEnabled) {
          await assertVariablesNotProxyOnly(
            tx,
            projectId,
            [options.environmentId],
            [environmentVariable.key]
          );
        }
        await this.encryption.assertWrite(tx, [...prepared.values()]);
        const secretStore = this.#secretStore(
          tx,
          projectId,
          [options.environmentId],
          prepared,
          new Set()
        );

        const key = secretKey(projectId, options.environmentId, environmentVariable.key);
        await secretStore.setSecret<{ secret: string }>(key, {
          secret: value,
        });

        await tx.environmentVariableValue.update({
          where: {
            variableId_environmentId: {
              variableId: environmentVariable.id,
              environmentId: options.environmentId,
            },
          },
          data: {
            version: {
              increment: 1,
            },
            lastUpdatedBy: options.lastUpdatedBy ? options.lastUpdatedBy : undefined,
          },
        });
      });

      return {
        success: true as const,
      };
    } catch (error) {
      return writeFailure(error, "editValue", projectId);
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

    const secretStore = this.#secretStore(
      this.prismaClient,
      projectId,
      project.environments.map((e) => e.id)
    );

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

  async getVariableValuesForKeys(
    projectId: string,
    items: Array<{ environmentId: string; key: string }>
  ): Promise<Map<string, string>> {
    if (items.length === 0) {
      return new Map();
    }

    const uniqueItems = new Map<string, { environmentId: string; key: string }>();
    for (const item of items) {
      uniqueItems.set(`${item.environmentId}:${item.key}`, item);
    }

    const secretStore = this.#secretStore(
      this.replicaClient,
      projectId,
      items.map((item) => item.environmentId)
    );

    const storeKeys = Array.from(uniqueItems.values()).map((item) =>
      secretKey(projectId, item.environmentId, item.key)
    );

    const secrets = await secretStore.getSecretsByKeys(SecretValue, storeKeys);
    const secretsByStoreKey = new Map(secrets.map((secret) => [secret.key, secret.value.secret]));

    const values = new Map<string, string>();
    for (const item of uniqueItems.values()) {
      const storeKey = secretKey(projectId, item.environmentId, item.key);
      const value = secretsByStoreKey.get(storeKey);
      if (value !== undefined) {
        values.set(`${item.environmentId}:${item.key}`, value);
      }
    }

    return values;
  }

  async getEnvironmentWithRedactedSecrets(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string
  ): Promise<EnvironmentVariableWithSecret[]> {
    const variables = await this.getEnvironment(projectId, environmentId, parentEnvironmentId);

    // Get the keys of all secret variables
    const secretValues = await this.replicaClient.environmentVariableValue.findMany({
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

  async resolveEnvironmentVariables(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string,
    // Unset means enabled: callers that do not know the org flag keep full protection.
    options?: { readFromReplica?: boolean; proxyEnabled?: boolean }
  ) {
    const db = options?.readFromReplica ? this.replicaClient : this.prismaClient;
    const environmentIds = parentEnvironmentId
      ? [parentEnvironmentId, environmentId]
      : [environmentId];
    const protectedKeys =
      options?.proxyEnabled === false
        ? new Set<string>()
        : await protectedSecretKeys(db, projectId, environmentIds);
    const proxyValues = protectedKeys.size
      ? (
          await effectiveEnvironmentVariables(db, projectId, environmentId, parentEnvironmentId)
        ).filter((value) => value.isProxyOnly)
      : [];
    // A protected child value must not fall back to an ordinary parent value.
    for (const value of proxyValues) {
      for (const id of environmentIds) protectedKeys.add(secretKey(projectId, id, value.key));
    }
    const secretStore = new EnvironmentSecretStore(
      db,
      this.encryption,
      projectId,
      environmentIds,
      undefined,
      protectedKeys
    );
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
    const merged = new Map<string, string>();
    for (const secret of [...parentSecrets, ...childSecrets]) {
      merged.set(parseSecretKey(secret.key).key, secret.value.secret);
    }
    return {
      variables: removeBlacklistedVariables([...merged].map(([key, value]) => ({ key, value }))),
      proxyValues,
    };
  }

  async getEnvironmentVariables(
    projectId: string,
    environmentId: string,
    parentEnvironmentId?: string,
    options?: { readFromReplica?: boolean }
  ): Promise<EnvironmentVariable[]> {
    return (
      await this.resolveEnvironmentVariables(projectId, environmentId, parentEnvironmentId, options)
    ).variables;
  }

  async deleteValue(projectId: string, options: DeleteEnvironmentVariableValue): Promise<Result> {
    const project = await this.prismaClient.project.findFirst({
      where: {
        id: projectId,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (!project) {
      return { success: false as const, error: "Project not found" };
    }

    // Through the batch path, which locks the variable: whether this is its last value is
    // decided inside the transaction, so a value being added meanwhile keeps its variable.
    const result = await this.deleteValues(projectId, [options]);
    if (!result.success) {
      return result;
    }
    if (result.deleted.length > 0) {
      return { success: true as const };
    }

    const environmentVariable = await this.prismaClient.environmentVariable.findFirst({
      select: { id: true },
      where: { id: options.id, projectId },
    });

    return {
      success: false as const,
      error: environmentVariable
        ? "Environment variable value not found"
        : "Environment variable not found",
    };
  }

  /**
   * Deletes several values in one transaction: all of them or none. Each value goes with its
   * secret, its secret reference and its row, and a variable left with no value goes with it. A value that is already gone is skipped, so the result lists
   * what was deleted. The caller authorizes every environment first.
   */
  async deleteValues(
    projectId: string,
    values: DeleteEnvironmentVariableValue[]
  ): Promise<DeleteValuesResult> {
    const requested = new Set(values.map((value) => `${value.id}:${value.environmentId}`));
    const variableIds = [...new Set(values.map((value) => value.id))];
    const environmentIds = [...new Set(values.map((value) => value.environmentId))];

    try {
      const deleted = await $transaction(this.prismaClient, "delete env var values", async (tx) => {
        // Lock the variables first, in id order, so overlapping batches queue instead of
        // deadlocking and each counts only what it deleted. A value being added to one of them
        // meanwhile either commits first, and keeps its variable below, or waits for this
        // transaction and then fails on the deleted variable: never deleted unseen by the cascade.
        await tx.$queryRaw`SELECT id FROM "EnvironmentVariable" WHERE "projectId" = ${projectId} AND id = ANY(${variableIds}) ORDER BY id FOR UPDATE`;

        const variables = await tx.environmentVariable.findMany({
          where: { projectId, id: { in: boundedIn(variableIds) } },
          select: {
            id: true,
            key: true,
            values: {
              where: { environmentId: { in: boundedIn(environmentIds) } },
              select: {
                id: true,
                environmentId: true,
                valueReference: { select: { key: true } },
              },
            },
          },
        });

        const found = variables.flatMap((variable) =>
          variable.values
            .filter((value) => requested.has(`${variable.id}:${value.environmentId}`))
            .map((value) => ({ variable, value }))
        );
        if (found.length === 0) {
          return [];
        }

        // One proxy-only value refuses the whole batch. Checked per environment, so a key is only
        // looked up where it is being deleted: the same key may be proxy-only somewhere else.
        // It locks the same variable rows, which this transaction already holds.
        for (const environmentId of new Set(found.map(({ value }) => value.environmentId))) {
          await assertVariablesNotProxyOnly(
            tx,
            projectId,
            [environmentId],
            found
              .filter(({ value }) => value.environmentId === environmentId)
              .map(({ variable }) => variable.key)
          );
        }

        // By set, so a batch is four statements however many values it holds, and a row another
        // request removed in the meantime doesn't fail the rest.
        await tx.secretStore.deleteMany({
          where: {
            key: {
              in: boundedIn(
                found.map(({ variable, value }) =>
                  secretKey(projectId, value.environmentId, variable.key)
                )
              ),
            },
          },
        });
        await tx.secretReference.deleteMany({
          where: {
            key: {
              in: boundedIn(found.flatMap(({ value }) => value.valueReference?.key ?? [])),
            },
          },
        });
        await tx.environmentVariableValue.deleteMany({
          where: { id: { in: boundedIn(found.map(({ value }) => value.id)) } },
        });
        // Checked after the values are gone, so a variable that gained a value first stays.
        await tx.environmentVariable.deleteMany({
          where: {
            projectId,
            id: { in: boundedIn([...new Set(found.map(({ variable }) => variable.id))]) },
            values: { none: {} },
          },
        });

        return found.map(({ variable, value }) => ({
          id: variable.id,
          key: variable.key,
          environmentId: value.environmentId,
        }));
      });

      if (!deleted) {
        return { success: false as const, error: "Something went wrong" };
      }

      return { success: true as const, deleted };
    } catch (error) {
      return writeFailure(error, "deleteValues", projectId);
    }
  }

  /**
   * Copies the values of the given variables from one environment to another, in one
   * transaction: all of them or none. The values are read here, never taken from the caller. A
   * secret stays a secret: a value copied from a secret is a secret in the target, and a target
   * that is a secret stays one. The caller authorizes both environments first.
   */
  async copyValues(
    projectId: string,
    options: CopyEnvironmentVariableValues
  ): Promise<CopyValuesResult> {
    const { sourceEnvironmentId, targetEnvironmentId, lastUpdatedBy } = options;
    const variableIds = [...new Set(options.variableIds)];
    const refuse = (reason: string) => new CopyRefusedError(`Nothing was copied. ${reason}`);

    const project = await this.prismaClient.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        organization: { select: { featureFlags: true } },
        environments: {
          where: { id: { in: [sourceEnvironmentId, targetEnvironmentId] }, archivedAt: null },
          select: {
            id: true,
            type: true,
            branchName: true,
            parentEnvironmentId: true,
            encryptionPolicy: { select: { activeKeyId: true, revision: true } },
          },
        },
      },
    });
    if (!project) {
      return { success: false as const, error: "Project not found" };
    }
    const source = project.environments.find((e) => e.id === sourceEnvironmentId);
    const target = project.environments.find((e) => e.id === targetEnvironmentId);
    if (!source || !target || source.id === target.id) {
      return { success: false as const, error: "Nothing was copied. Environment not found." };
    }

    const emptyAllowed = await emptyEnvironmentVariableValuesEnabled(
      project.organization.featureFlags,
      this.prismaClient
    );

    try {
      const prepared = await this.#prepareWrites(projectId, [target]);
      const copied = await $transaction(this.prismaClient, "copy env var values", async (tx) => {
        // Locks the variables first, in the order every batch takes them, so what is read below
        // is what a save or delete that held them left behind.
        await tx.$queryRaw`SELECT id FROM "EnvironmentVariable" WHERE "projectId" = ${projectId} AND id = ANY(${variableIds}) ORDER BY id FOR UPDATE`;
        // Then the source values: a save that doesn't lock the variable (create, with the secret
        // proxy off) still holds the value row, so whether it's a secret and its plaintext are
        // read from the same save.
        await tx.$queryRaw`SELECT id FROM "EnvironmentVariableValue" WHERE "environmentId" = ${source.id} AND "variableId" = ANY(${variableIds}) ORDER BY id FOR UPDATE`;
        const variables = await tx.environmentVariable.findMany({
          where: { projectId, id: { in: boundedIn(variableIds) } },
          select: {
            id: true,
            key: true,
            values: {
              where: { environmentId: { in: [source.id, target.id] } },
              select: { environmentId: true, isSecret: true },
            },
          },
          orderBy: { key: "asc" },
        });
        if (variables.length !== variableIds.length) {
          throw refuse("A selected variable wasn't found in this project.");
        }
        const keys = variables.map((variable) => variable.key);
        const named = (list: string[]) =>
          `${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}`;

        const notSet = variables.filter(
          (variable) => !variable.values.some((v) => v.environmentId === source.id)
        );
        if (notSet.length > 0) {
          throw refuse(
            `${named(notSet.map((v) => v.key))} ${notSet.length === 1 ? "isn't" : "aren't"} set in ${environmentFullTitle(source)}.`
          );
        }
        const reserved = keys.filter(isBlacklistedVariable);
        if (reserved.length > 0) {
          throw refuse(`${named(reserved)} can't be set.`);
        }

        // Refuses a proxy-only target value (its lock is the one already held).
        await assertVariablesNotProxyOnly(tx, projectId, [target.id], keys).catch(
          (error: unknown) => {
            throw error instanceof Error && error.message.startsWith("Proxy-only")
              ? refuse(`${error.message}.`)
              : error;
          }
        );
        await this.encryption.assertWrite(tx, [...prepared.values()]);

        // Read after the lock, so what is copied is the value as it is now. A proxy-only value
        // isn't readable, so it isn't returned.
        const sourceValues = new Map(
          (
            await this.#secretStore(tx, projectId, [source.id]).getSecretsByKeys(
              SecretValue,
              keys.map((key) => secretKey(projectId, source.id, key))
            )
          ).map((secret) => [parseSecretKey(secret.key).key, secret.value.secret])
        );
        const unreadable = keys.filter((key) => !sourceValues.has(key));
        if (unreadable.length > 0) {
          throw refuse(
            `${named(unreadable)} can't be read in ${environmentFullTitle(source)}. Proxy-only variables can only be changed by the secret proxy operator.`
          );
        }
        const empty = keys.filter((key) => sourceValues.get(key)!.trim() === "");
        if (empty.length > 0 && !emptyAllowed) {
          throw refuse(
            `${named(empty)} ${empty.length === 1 ? "is" : "are"} empty. ${EMPTY_ENV_VALUES_DISABLED}`
          );
        }

        const result: Array<{ id: string; key: string; created: boolean }> = [];
        for (const variable of variables) {
          const sourceIsSecret = variable.values.find(
            (v) => v.environmentId === source.id
          )!.isSecret;
          const written = await this.#writeVariable(tx, projectId, {
            key: variable.key,
            value: sourceValues.get(variable.key)!,
            environmentIds: [target.id],
            // Only ever made a secret: a plain value copied onto a secret leaves it a secret.
            isSecret: sourceIsSecret ? true : undefined,
            parentEnvironmentId: target.parentEnvironmentId ?? undefined,
            lastUpdatedBy,
            prepared,
          });
          result.push({
            id: variable.id,
            key: variable.key,
            created: written.get(target.id)?.created ?? false,
          });
        }
        return result;
      });

      if (!copied) {
        return { success: false as const, error: "Something went wrong" };
      }
      return { success: true as const, copied };
    } catch (error) {
      if (error instanceof CopyRefusedError) {
        return { success: false as const, error: error.message };
      }
      if (error instanceof EnvironmentKeyUnavailableError) {
        return {
          success: false as const,
          error:
            "Nothing was copied. An encryption key for one of these environments is unavailable right now. Try again later.",
        };
      }
      return writeFailure(error, "copyValues", projectId);
    }
  }
}

/** A copy refused before anything was written, with the sentence for the user. */
class CopyRefusedError extends Error {}

// Derived from the slim AuthenticatedEnvironment so a full AE satisfies
// this type — the legacy Prisma payload had `builtInEnvironmentVariableOverrides`
// as Prisma's JsonValue, which is a subtype of `unknown` in the slim
// shape, causing assignability errors in the JWT/queue paths that pass
// AE values straight through. Using Pick<AE, ...> aligns them.
export type RuntimeEnvironmentForEnvRepo = Pick<
  AuthenticatedEnvironment,
  | "id"
  | "slug"
  | "type"
  | "projectId"
  | "apiKey"
  | "organizationId"
  | "branchName"
  | "builtInEnvironmentVariableOverrides"
> & { organization?: { featureFlags: unknown } | null };

const environmentVariablesRepository = new EnvironmentVariablesRepository();

export async function resolveVariablesForEnvironment(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo
) {
  return (await prepareVariablesForEnvironment(runtimeEnvironment, parentEnvironment)).variables;
}

export async function prepareVariablesForEnvironment(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo,
  options?: { proxyEnabled?: boolean }
) {
  const resolved = await environmentVariablesRepository.resolveEnvironmentVariables(
    runtimeEnvironment.projectId,
    runtimeEnvironment.id,
    parentEnvironment?.id,
    {
      readFromReplica: env.CONTROL_PLANE_DEQUEUE_READS_FROM_REPLICA === "1",
      proxyEnabled: options?.proxyEnabled,
    }
  );

  const renames = { OTEL_RESOURCE_ATTRIBUTES: "CUSTOM_OTEL_RESOURCE_ATTRIBUTES" };
  const projectSecrets = renameVariables(resolved.variables, renames);

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

  return {
    variables: result,
    proxyValues: resolved.proxyValues
      .filter(
        (value) =>
          !isBlacklistedVariable(value.key) &&
          !builtInVariables.some((builtIn) => builtIn.key === value.key)
      )
      .map((value) => ({ ...value, key: renames[value.key as keyof typeof renames] ?? value.key })),
  };
}

function renameVariables(variables: EnvironmentVariable[], renameMap: Record<string, string>) {
  return variables.map((variable) => {
    return {
      ...variable,
      key: renameMap[variable.key] ?? variable.key,
    };
  });
}

async function resolveOverridableTriggerVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo
) {
  let result: Array<EnvironmentVariable> = [
    {
      key: "TRIGGER_REALTIME_STREAM_VERSION",
      value: env.REALTIME_STREAM_VERSION,
    },
    {
      key: "TRIGGER_DASHBOARD_URL",
      value: env.APP_ORIGIN.replace(/\/$/, ""),
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

  if (env.DEV_OTEL_METRICS_ENDPOINT) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_ENDPOINT",
      value: env.DEV_OTEL_METRICS_ENDPOINT,
    });
  }

  if (env.DEV_OTEL_METRICS_EXPORT_INTERVAL_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_EXPORT_INTERVAL_MILLIS",
      value: env.DEV_OTEL_METRICS_EXPORT_INTERVAL_MILLIS,
    });
  }

  if (env.DEV_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS",
      value: env.DEV_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS,
    });
  }

  if (env.DEV_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS",
      value: env.DEV_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS,
    });
  }

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

  // Dev branches set branchName too, so carry it to the task via the same
  // TRIGGER_PREVIEW_BRANCH var the prod path uses.
  if (runtimeEnvironment.branchName) {
    result = result.concat([
      {
        key: "TRIGGER_PREVIEW_BRANCH",
        value: runtimeEnvironment.branchName,
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

// Deployed runs normally get the public API origin. When INTERNAL_API_ORIGIN is
// set and the org's internalApiOriginEnabled flag resolves on (org override wins
// in both directions; INTERNAL_API_ORIGIN_ENABLED is the global default applied
// only when the org has not set it), they get the internal origin instead. The
// global default is the cached DB flag with INTERNAL_API_ORIGIN_ENABLED as the
// fallback; org flags are read in-memory, so a flip applies on the next attempt.
function resolveProdApiOrigin(runtimeEnvironment: RuntimeEnvironmentForEnvRepo): string {
  const publicOrigin = env.API_ORIGIN ?? env.APP_ORIGIN;

  if (!env.INTERNAL_API_ORIGIN) {
    return publicOrigin;
  }

  const enabled = resolveInternalApiOriginEnabled({
    orgFeatureFlags: runtimeEnvironment.organization?.featureFlags,
    globalDefault:
      globalFlagsRegistry.current()?.[FEATURE_FLAG.internalApiOriginEnabled] ??
      env.INTERNAL_API_ORIGIN_ENABLED === "1",
  });

  return enabled ? env.INTERNAL_API_ORIGIN : publicOrigin;
}

async function resolveBuiltInProdVariables(
  runtimeEnvironment: RuntimeEnvironmentForEnvRepo,
  parentEnvironment?: RuntimeEnvironmentForEnvRepo
) {
  const apiOrigin = resolveProdApiOrigin(runtimeEnvironment);

  let result: Array<EnvironmentVariable> = [
    {
      key: "TRIGGER_SECRET_KEY",
      value: parentEnvironment?.apiKey ?? runtimeEnvironment.apiKey,
    },
    {
      key: "TRIGGER_API_URL",
      value: apiOrigin,
    },
    {
      // Deliberately not switched by internalApiOriginEnabled: streams are
      // long-lived connections served on their own path.
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

  if (env.PROD_OTEL_METRICS_EXPORT_INTERVAL_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_EXPORT_INTERVAL_MILLIS",
      value: env.PROD_OTEL_METRICS_EXPORT_INTERVAL_MILLIS,
    });
  }

  if (env.PROD_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS",
      value: env.PROD_OTEL_METRICS_EXPORT_TIMEOUT_MILLIS,
    });
  }

  if (env.PROD_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS) {
    result.push({
      key: "TRIGGER_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS",
      value: env.PROD_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS,
    });
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
    {
      key: "TRIGGER_WAIT_UNTIL_TIMEOUT_MS",
      value: resolveBuiltInEnvironmentVariableOverrides(
        "TRIGGER_WAIT_UNTIL_TIMEOUT_MS",
        runtimeEnvironment,
        String(env.WAIT_UNTIL_TIMEOUT_MS)
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
    overrides !== null &&
    key in overrides
  ) {
    const value = (overrides as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }
  }

  return defaultValue;
}
