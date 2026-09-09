import type {
  PrismaClient,
  PrismaTransactionClient,
  RuntimeEnvironment,
} from "@trigger.dev/database";
import type { HostRbacController } from "@trigger.dev/rbac";
import { customAlphabet } from "nanoid";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { $transaction, boundedIn, prisma } from "~/db.server";
import { RuntimeEnvironmentType } from "~/database-types";
import { canIssueAdditionalApiKeys } from "~/services/additionalApiKeyIssuance.server";
import { apiKeyTelemetry, type ApiKeyTelemetry } from "~/services/apiKeyTelemetry.server";
import { rbac } from "~/services/rbac.server";
import { generateAdditionalApiKey, generateRootApiKey } from "~/utils/apiKeys";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

const apiKeyId = customAlphabet(
  "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  12
);

const REVOKED_API_KEY_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

type RootApiKeyMutationInput = {
  userId: string;
  environmentId: string;
};

export class RootApiKeyNotVisibleError extends Error {
  constructor() {
    super("The root API key is no longer visible");
    this.name = "RootApiKeyNotVisibleError";
  }
}

async function findRootApiKeyEnvironment(
  { userId, environmentId }: RootApiKeyMutationInput,
  prismaClient: PrismaClient
) {
  const requestedEnvironment = await prismaClient.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      organization: { members: { some: { userId } } },
      OR: [
        { type: { not: RuntimeEnvironmentType.DEVELOPMENT } },
        {
          type: RuntimeEnvironmentType.DEVELOPMENT,
          orgMember: { userId },
        },
      ],
    },
    select: { id: true, parentEnvironmentId: true },
  });

  if (!requestedEnvironment) {
    throw new Error("User does not have permission to manage this root API key");
  }

  const environment = await prismaClient.runtimeEnvironment.findFirst({
    where: {
      id: requestedEnvironment.parentEnvironmentId ?? requestedEnvironment.id,
      organization: { members: { some: { userId } } },
      OR: [
        { type: { not: RuntimeEnvironmentType.DEVELOPMENT } },
        {
          type: RuntimeEnvironmentType.DEVELOPMENT,
          orgMember: { userId },
        },
      ],
    },
    select: {
      id: true,
      apiKey: true,
      pkApiKey: true,
      rootApiKeyHiddenAt: true,
      type: true,
      projectId: true,
      branchName: true,
    },
  });

  if (!environment) {
    throw new Error("User does not have permission to manage this root API key");
  }

  if (environment.rootApiKeyHiddenAt) {
    throw new RootApiKeyNotVisibleError();
  }

  return environment;
}

async function lockVisibleRootApiKeyEnvironment(
  prismaClient: PrismaTransactionClient,
  environmentId: string
) {
  const [environment] = await prismaClient.$queryRaw<
    Array<{ apiKey: string; rootApiKeyHiddenAt: Date | null }>
  >`
    SELECT "apiKey", "rootApiKeyHiddenAt"
    FROM "public"."RuntimeEnvironment"
    WHERE "id" = ${environmentId}
    FOR UPDATE
  `;

  if (!environment || environment.rootApiKeyHiddenAt) {
    throw new RootApiKeyNotVisibleError();
  }

  return environment;
}

export async function regenerateApiKey(
  input: RootApiKeyMutationInput,
  { prismaClient = prisma }: { prismaClient?: PrismaClient } = {}
) {
  const environment = await findRootApiKeyEnvironment(input, prismaClient);
  const newApiKey = createApiKeyForEnv(environment.type);
  const newPkApiKey = createPkApiKeyForEnv(environment.type);
  const revokedApiKeyExpiresAt = new Date(Date.now() + REVOKED_API_KEY_GRACE_PERIOD_MS);

  const updatedEnvironment = await $transaction(
    prismaClient,
    "regenerate root API key",
    async (tx) => {
      const currentEnvironment = await lockVisibleRootApiKeyEnvironment(tx, environment.id);

      await tx.runtimeEnvironment.update({
        where: { id: environment.id },
        data: {
          apiKey: newApiKey,
          pkApiKey: newPkApiKey,
        },
      });

      await tx.revokedApiKey.create({
        data: {
          apiKey: currentEnvironment.apiKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: revokedApiKeyExpiresAt,
        },
      });

      return { ...environment, apiKey: newApiKey, pkApiKey: newPkApiKey };
    }
  );

  if (!updatedEnvironment) {
    throw new Error("The root API key could not be regenerated");
  }

  controlPlaneResolver.invalidateEnvironment(environment.id);

  return updatedEnvironment;
}

export async function disableRootApiKeyVisibility(
  input: RootApiKeyMutationInput,
  { prismaClient = prisma }: { prismaClient?: PrismaClient } = {}
) {
  const environment = await findRootApiKeyEnvironment(input, prismaClient);
  const newApiKey = createApiKeyForEnv(environment.type);
  const newPkApiKey = createPkApiKeyForEnv(environment.type);
  const rootApiKeyHiddenAt = new Date();

  const updatedEnvironment = await $transaction(
    prismaClient,
    "disable root API key visibility",
    async (tx) => {
      const currentEnvironment = await lockVisibleRootApiKeyEnvironment(tx, environment.id);

      await tx.runtimeEnvironment.update({
        where: { id: environment.id },
        data: {
          apiKey: newApiKey,
          pkApiKey: newPkApiKey,
          rootApiKeyHiddenAt,
        },
      });

      await tx.revokedApiKey.create({
        data: {
          apiKey: currentEnvironment.apiKey,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date(Date.now() + REVOKED_API_KEY_GRACE_PERIOD_MS),
        },
      });

      return {
        ...environment,
        apiKey: newApiKey,
        pkApiKey: newPkApiKey,
        rootApiKeyHiddenAt,
      };
    }
  );

  if (!updatedEnvironment) {
    throw new Error("Root API key visibility could not be disabled");
  }

  controlPlaneResolver.invalidateEnvironment(environment.id);

  return updatedEnvironment;
}

export async function createEnvironmentApiKey(
  {
    environmentId,
    taskEnvironmentId,
    userId,
    name,
    expiresAt,
    presetId,
    taskIdentifiers,
  }: {
    environmentId: string;
    taskEnvironmentId: string;
    userId: string;
    name: string;
    expiresAt?: Date;
    presetId: string;
    taskIdentifiers?: string[];
  },
  {
    prismaClient = prisma,
    rbacController = rbac,
    issuanceAllowed,
    telemetryRecorder = apiKeyTelemetry,
  }: {
    prismaClient?: Pick<
      PrismaClient,
      "apiKey" | "featureFlag" | "organization" | "runtimeEnvironment" | "taskIdentifier"
    >;
    rbacController?: Pick<HostRbacController, "prepareApiKeyPolicy">;
    issuanceAllowed?: (organizationId: string) => Promise<boolean>;
    telemetryRecorder?: ApiKeyTelemetry;
  } = {}
) {
  const environment = await prismaClient.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      organization: { members: { some: { userId } } },
    },
    select: { id: true, type: true, organizationId: true },
  });

  if (!environment) {
    throw new Error("Environment not found");
  }

  const canIssue =
    issuanceAllowed ??
    ((organizationId) => canIssueAdditionalApiKeys(organizationId, prismaClient));
  if (!(await canIssue(environment.organizationId))) {
    throw new Error("Creating additional API keys is not enabled.");
  }

  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new Error("Expiration must be in the future");
  }

  const selectedTasks = [...new Set(taskIdentifiers?.map((task) => task.trim()).filter(Boolean))];

  if (selectedTasks.length > MAX_API_KEY_TASK_IDENTIFIERS) {
    throw new Error(`You can select at most ${MAX_API_KEY_TASK_IDENTIFIERS} tasks for an API key`);
  }
  if (selectedTasks.length > 0) {
    const matchingTasks = await prismaClient.taskIdentifier.count({
      where: {
        runtimeEnvironmentId: taskEnvironmentId,
        slug: { in: boundedIn(selectedTasks) },
        runtimeEnvironment: {
          OR: [{ id: environment.id }, { parentEnvironmentId: environment.id }],
        },
      },
    });

    if (matchingTasks !== selectedTasks.length) {
      throw new Error("One or more selected tasks are not available in this environment");
    }
  }

  let prepared: Awaited<ReturnType<typeof rbacController.prepareApiKeyPolicy>>;
  try {
    prepared = await rbacController.prepareApiKeyPolicy({
      organizationId: environment.organizationId,
      presetId,
      taskIdentifiers: selectedTasks.length > 0 ? selectedTasks : undefined,
    });
  } catch (error) {
    telemetryRecorder.recordOperation("prepare_policy", "error", "policy_error");
    throw error;
  }

  if (!prepared.ok) {
    telemetryRecorder.recordOperation("prepare_policy", "rejected", "policy_rejected");
    throw new Error(prepared.error);
  }
  telemetryRecorder.recordOperation("prepare_policy", "success");

  const generated = generateAdditionalApiKey(environment.type);
  const apiKey = await (async () => {
    try {
      return await prismaClient.apiKey.create({
        data: {
          name,
          keyHash: generated.keyHash,
          lastFour: generated.lastFour,
          runtimeEnvironmentId: environment.id,
          createdByUserId: userId,
          expiresAt,
          presetId: prepared.policy.presetId,
          scopes: prepared.policy.scopes,
        },
      });
    } catch (error) {
      telemetryRecorder.recordOperation("create", "error", "database_error");
      throw error;
    }
  })();
  telemetryRecorder.recordOperation("create", "success");

  return { apiKey, plaintext: generated.apiKey };
}

export async function revokeEnvironmentApiKey(
  {
    environmentId,
    apiKeyId,
  }: {
    environmentId: string;
    apiKeyId: string;
  },
  {
    prismaClient = prisma,
    telemetryRecorder = apiKeyTelemetry,
  }: {
    prismaClient?: Pick<PrismaClient, "apiKey">;
    telemetryRecorder?: ApiKeyTelemetry;
  } = {}
) {
  const result = await (async () => {
    try {
      return await prismaClient.apiKey.updateMany({
        where: {
          id: apiKeyId,
          runtimeEnvironmentId: environmentId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    } catch (error) {
      telemetryRecorder.recordOperation("revoke", "error", "database_error");
      throw error;
    }
  })();

  if (result.count !== 1) {
    telemetryRecorder.recordOperation("revoke", "rejected", "not_found_or_revoked");
    throw new Error("API key not found or already revoked");
  }

  telemetryRecorder.recordOperation("revoke", "success");
}

export function createApiKeyForEnv(envType: RuntimeEnvironment["type"]) {
  return generateRootApiKey(envType).apiKey;
}

export function createPkApiKeyForEnv(envType: RuntimeEnvironment["type"]) {
  return `pk_${envSlug(envType)}_${apiKeyId(20)}`;
}

export type EnvSlug = "dev" | "stg" | "prod" | "preview";

export function envSlug(environmentType: RuntimeEnvironment["type"]): EnvSlug {
  switch (environmentType) {
    case "DEVELOPMENT": {
      return "dev";
    }
    case "PRODUCTION": {
      return "prod";
    }
    case "STAGING": {
      return "stg";
    }
    case "PREVIEW": {
      return "preview";
    }
  }
}

export function isEnvSlug(maybeSlug: string): maybeSlug is EnvSlug {
  return ["dev", "stg", "prod", "preview"].includes(maybeSlug);
}
