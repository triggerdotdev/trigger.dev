import type { PrismaClient, RuntimeEnvironment } from "@trigger.dev/database";
// HostRbacController, not RoleBaseAccessController: the policy methods are
// optional on the plugin-facing contract, and `rbac` (LazyController) has
// already substituted the fail-closed defaults for any an installed plugin
// omits. Depending on the host surface keeps this call site guard-free.
import type { HostRbacController } from "@trigger.dev/rbac";
import { trail } from "agentcrumbs"; // @crumbs
import { customAlphabet } from "nanoid";
import { prisma } from "~/db.server";
import { RuntimeEnvironmentType } from "~/database-types";
import { rbac } from "~/services/rbac.server";
import { generateAdditionalApiKey, generateRootApiKey } from "~/utils/apiKeys";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

const crumb = trail("webapp"); // @crumbs

export const MAX_API_KEY_TASK_IDENTIFIERS = 10;

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
    // Required, and passed straight through to `prepareApiKeyPolicy` — callers
    // name the access level rather than leaning on a default that would grant
    // full access. Installs with no preset catalogue pass FULL_ACCESS_PRESET_ID.
    presetId: string;
    taskIdentifiers?: string[];
  },
  {
    prismaClient = prisma,
    rbacController = rbac,
  }: {
    prismaClient?: Pick<PrismaClient, "runtimeEnvironment" | "taskIdentifier" | "apiKey">;
    rbacController?: Pick<HostRbacController, "prepareApiKeyPolicy">;
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
        slug: { in: selectedTasks },
        runtimeEnvironment: {
          OR: [{ id: environment.id }, { parentEnvironmentId: environment.id }],
        },
      },
    });

    if (matchingTasks !== selectedTasks.length) {
      throw new Error("One or more selected tasks are not available in this environment");
    }
  }

  const prepared = await rbacController.prepareApiKeyPolicy({
    organizationId: environment.organizationId,
    presetId,
    taskIdentifiers: selectedTasks.length > 0 ? selectedTasks : undefined,
  });

  if (!prepared.ok) {
    throw new Error(prepared.error);
  }

  const generated = generateAdditionalApiKey(environment.type);
  const apiKey = await prismaClient.apiKey.create({
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

  crumb("environment API key created", {
    apiKeyId: apiKey.id,
    environmentId,
    presetId: apiKey.presetId,
  }); // @crumbs

  return { apiKey, plaintext: generated.apiKey };
}

export async function revokeEnvironmentApiKey({
  environmentId,
  apiKeyId,
}: {
  environmentId: string;
  apiKeyId: string;
}) {
  const result = await prisma.apiKey.updateMany({
    where: {
      id: apiKeyId,
      runtimeEnvironmentId: environmentId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  if (result.count !== 1) {
    throw new Error("API key not found or already revoked");
  }

  crumb("environment API key revoked", { apiKeyId, environmentId }); // @crumbs
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
