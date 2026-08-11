import type { PrismaClient, RuntimeEnvironment } from "@trigger.dev/database";
import type { HostRbacController } from "@trigger.dev/rbac";
import { customAlphabet } from "nanoid";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { boundedIn, prisma } from "~/db.server";
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

type RegenerateAPIKeyInput = {
  userId: string;
  environmentId: string;
};

export async function regenerateApiKey({ userId, environmentId }: RegenerateAPIKeyInput) {
  const environment = await prisma.runtimeEnvironment.findUnique({
    where: {
      id: environmentId,
    },
    include: {
      organization: true,
      project: true,
    },
  });

  if (!environment) {
    throw new Error("Environment does not exist");
  }

  // check if the user is part of the org
  const organization = await prisma.organization.findFirst({
    where: {
      id: environment.organization.id,
      members: { some: { userId } },
    },
  });

  if (!organization) {
    throw new Error("User does not have permission to regenerate API key");
  }

  // check if it is the user's dev environment
  if (environment.type === RuntimeEnvironmentType.DEVELOPMENT) {
    if (!environment.orgMemberId) {
      throw new Error("User does not have permission to regenerate API key");
    }

    const orgMember = await prisma.orgMember.findFirst({
      where: {
        organizationId: organization.id,
        userId: userId,
        id: environment.orgMemberId,
      },
    });

    if (!orgMember) {
      throw new Error("User does not have permission to regenerate API key");
    }
  }

  // generate and store new keys
  const newApiKey = createApiKeyForEnv(environment.type);
  const newPkApiKey = createPkApiKeyForEnv(environment.type);

  const revokedApiKeyExpiresAt = new Date(Date.now() + REVOKED_API_KEY_GRACE_PERIOD_MS);

  const updatedEnviroment = await prisma.$transaction(async (tx) => {
    await tx.revokedApiKey.create({
      data: {
        apiKey: environment.apiKey,
        runtimeEnvironmentId: environment.id,
        expiresAt: revokedApiKeyExpiresAt,
      },
    });

    return tx.runtimeEnvironment.update({
      data: {
        apiKey: newApiKey,
        pkApiKey: newPkApiKey,
      },
      where: {
        id: environmentId,
      },
    });
  });

  // The env's apiKey changed in the control-plane; drop any cached copy.
  controlPlaneResolver.invalidateEnvironment(environmentId);

  return updatedEnviroment;
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
