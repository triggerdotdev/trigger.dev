import type {
  PrismaClient,
  PrismaTransactionClient,
  RuntimeEnvironment,
} from "@trigger.dev/database";
import { parseIpRanges, type HostRbacController } from "@trigger.dev/rbac";
import { customAlphabet } from "nanoid";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { $transaction, boundedIn, prisma } from "~/db.server";
import { RuntimeEnvironmentType } from "~/database-types";
import { env } from "~/env.server";
import { apiKeyTelemetry, type ApiKeyTelemetry } from "~/services/apiKeyTelemetry.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import { generateAdditionalApiKey, generateRootApiKey } from "~/utils/apiKeys";
import {
  EXPIRED_API_KEY_MESSAGE,
  MISSING_API_KEY_MESSAGE,
  REVOKED_API_KEY_MESSAGE,
} from "~/utils/apiKeyAccess";
import {
  API_KEY_NOTE_MAX_LENGTH,
  API_KEY_NOTE_TOO_LONG_MESSAGE,
  normalizeApiKeyNote,
} from "~/utils/apiKeyNote";
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

type RegenerateApiKeyInput = RootApiKeyMutationInput & {
  revokeImmediately?: boolean;
  allowHidden?: boolean;
};

export class RootApiKeyNotVisibleError extends Error {
  constructor() {
    super("The root API key is no longer visible");
    this.name = "RootApiKeyNotVisibleError";
  }
}

export function isApiKeyUserError(error: unknown): boolean {
  return (
    error instanceof RootApiKeyNotVisibleError ||
    (error instanceof Error && error.constructor === Error)
  );
}

async function findRootApiKeyEnvironment(
  { userId, environmentId }: RootApiKeyMutationInput,
  prismaClient: PrismaClient,
  { allowHidden = false }: { allowHidden?: boolean } = {}
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

  if (environment.rootApiKeyHiddenAt && !allowHidden) {
    throw new RootApiKeyNotVisibleError();
  }

  return environment;
}

async function lockRootApiKeyEnvironment(
  prismaClient: PrismaTransactionClient,
  environmentId: string,
  { allowHidden = false }: { allowHidden?: boolean } = {}
) {
  const [environment] = await prismaClient.$queryRaw<
    Array<{ apiKey: string; rootApiKeyHiddenAt: Date | null }>
  >`
    SELECT "apiKey", "rootApiKeyHiddenAt"
    FROM "public"."RuntimeEnvironment"
    WHERE "id" = ${environmentId}
    FOR UPDATE
  `;

  if (!environment || (environment.rootApiKeyHiddenAt && !allowHidden)) {
    throw new RootApiKeyNotVisibleError();
  }

  return environment;
}

export async function regenerateApiKey(
  { revokeImmediately = false, allowHidden = false, ...input }: RegenerateApiKeyInput,
  { prismaClient = prisma }: { prismaClient?: PrismaClient } = {}
) {
  const environment = await findRootApiKeyEnvironment(input, prismaClient, { allowHidden });
  const newApiKey = createApiKeyForEnv(environment.type);
  const newPkApiKey = createPkApiKeyForEnv(environment.type);
  const revokedApiKeyExpiresAt = new Date(Date.now() + REVOKED_API_KEY_GRACE_PERIOD_MS);

  const updatedEnvironment = await $transaction(
    prismaClient,
    "regenerate root API key",
    async (tx) => {
      const currentEnvironment = await lockRootApiKeyEnvironment(tx, environment.id, {
        allowHidden,
      });

      await tx.runtimeEnvironment.update({
        where: { id: environment.id },
        data: {
          apiKey: newApiKey,
          pkApiKey: newPkApiKey,
        },
      });

      if (revokeImmediately) {
        const now = new Date();
        await tx.revokedApiKey.updateMany({
          where: { runtimeEnvironmentId: environment.id, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });
      } else {
        await tx.revokedApiKey.create({
          data: {
            apiKey: currentEnvironment.apiKey,
            runtimeEnvironmentId: environment.id,
            expiresAt: revokedApiKeyExpiresAt,
          },
        });
      }

      return {
        ...environment,
        apiKey: newApiKey,
        pkApiKey: newPkApiKey,
        rootApiKeyHiddenAt: currentEnvironment.rootApiKeyHiddenAt,
      };
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
      const currentEnvironment = await lockRootApiKeyEnvironment(tx, environment.id);

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
    description,
    expiresAt,
    presetId,
    taskIdentifiers,
    capabilities,
    allowedIpRanges,
  }: {
    environmentId: string;
    taskEnvironmentId: string;
    userId: string;
    name: string;
    // Optional one-line note; blank becomes null.
    description?: string | null;
    expiresAt?: Date;
    presetId: string;
    taskIdentifiers?: string[];
    capabilities?: Record<string, string>;
    // Raw user input: addresses or CIDR ranges. Empty or omitted allows any IP.
    allowedIpRanges?: string[];
  },
  {
    prismaClient = prisma,
    rbacController = rbac,
    telemetryRecorder = apiKeyTelemetry,
    allowPrivateIpRanges = env.API_KEY_ALLOW_PRIVATE_IP_RANGES,
  }: {
    prismaClient?: PrismaClient;
    rbacController?: Pick<HostRbacController, "prepareApiKeyPolicy">;
    telemetryRecorder?: ApiKeyTelemetry;
    allowPrivateIpRanges?: boolean;
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

  const note = normalizeApiKeyNote(description);
  if (note !== null && note.length > API_KEY_NOTE_MAX_LENGTH) {
    throw new Error(API_KEY_NOTE_TOO_LONG_MESSAGE);
  }

  const ipRanges = parseIpRanges(allowedIpRanges ?? [], {
    allowNonPublicRanges: allowPrivateIpRanges,
  });
  if (!ipRanges.ok) {
    telemetryRecorder.recordOperation("create", "rejected", "invalid_ip_ranges");
    throw new Error(ipRanges.error);
  }

  const prepared = await prepareEnvironmentApiKeyPolicy(
    {
      environment,
      taskEnvironmentId,
      presetId,
      taskIdentifiers,
      capabilities,
    },
    { prismaClient, rbacController, telemetryRecorder }
  );

  const generated = generateAdditionalApiKey(environment.type);
  const apiKey = await (async () => {
    try {
      const create = (client: Pick<PrismaClient, "apiKey">) =>
        client.apiKey.create({
          data: {
            name,
            description: note,
            keyHash: generated.keyHash,
            lastFour: generated.lastFour,
            runtimeEnvironmentId: environment.id,
            createdByUserId: userId,
            expiresAt,
            presetId: prepared.policy.presetId,
            scopes: prepared.policy.scopes,
            allowedIpRanges: ipRanges.ranges,
          },
        });
      if (environment.type !== "DEVELOPMENT") {
        return await create(prismaClient);
      }
      const created = await $transaction(
        prismaClient,
        "create development API key",
        async (tx) => {
          const members = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT m."id" FROM "OrgMember" m
          JOIN "RuntimeEnvironment" e ON e."orgMemberId" = m."id"
          WHERE e."id" = ${environment.id}
            AND m."organizationId" = ${environment.organizationId}
            AND m."userId" = ${userId}
          FOR UPDATE OF m
        `;
          if (members.length === 0) {
            return null;
          }
          return create(tx);
        },
        { isolationLevel: "Serializable" }
      );
      if (created === undefined) {
        throw new Error("Failed to create development API key");
      }
      return created;
    } catch (error) {
      telemetryRecorder.recordOperation("create", "error", "database_error");
      throw error;
    }
  })();
  if (apiKey === null) {
    telemetryRecorder.recordOperation("create", "rejected", "membership_removed");
    throw new Error("Environment not found");
  }
  telemetryRecorder.recordOperation("create", "success");

  return { apiKey, plaintext: generated.apiKey };
}

async function prepareEnvironmentApiKeyPolicy(
  {
    environment,
    taskEnvironmentId,
    presetId,
    taskIdentifiers,
    capabilities,
  }: {
    environment: { id: string; organizationId: string };
    taskEnvironmentId: string;
    presetId: string;
    taskIdentifiers?: string[];
    capabilities?: Record<string, string>;
  },
  {
    prismaClient,
    rbacController,
    telemetryRecorder,
  }: {
    prismaClient: PrismaClient;
    rbacController: Pick<HostRbacController, "prepareApiKeyPolicy">;
    telemetryRecorder: ApiKeyTelemetry;
  }
) {
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
      capabilities,
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

  return prepared;
}

export async function updateEnvironmentApiKeyAccess(
  {
    environmentId,
    taskEnvironmentId,
    userId,
    apiKeyId,
    presetId,
    taskIdentifiers,
    capabilities,
  }: {
    environmentId: string;
    taskEnvironmentId: string;
    userId: string;
    apiKeyId: string;
    presetId: string;
    taskIdentifiers?: string[];
    capabilities?: Record<string, string>;
  },
  {
    prismaClient = prisma,
    rbacController = rbac,
    telemetryRecorder = apiKeyTelemetry,
  }: {
    prismaClient?: PrismaClient;
    rbacController?: Pick<HostRbacController, "prepareApiKeyPolicy">;
    telemetryRecorder?: ApiKeyTelemetry;
  } = {}
) {
  const environment = await prismaClient.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      organization: { members: { some: { userId } } },
    },
    select: { id: true, organizationId: true },
  });

  if (!environment) {
    throw new Error("Environment not found");
  }

  const findApiKey = () =>
    prismaClient.apiKey.findFirst({
      where: { id: apiKeyId, runtimeEnvironmentId: environment.id, issuedBy: "USER" },
      select: { revokedAt: true, expiresAt: true, presetId: true, scopes: true },
    });
  const reject = (uneditable: UneditableApiKey): never => {
    telemetryRecorder.recordOperation("update_access", "rejected", uneditable.reason);
    throw new Error(uneditable.message);
  };

  const current = await findApiKey();
  const uneditable = uneditableApiKeyReason(current);
  if (!current || uneditable) {
    return reject(uneditable ?? MISSING_API_KEY);
  }

  const prepared = await prepareEnvironmentApiKeyPolicy(
    { environment, taskEnvironmentId, presetId, taskIdentifiers, capabilities },
    { prismaClient, rbacController, telemetryRecorder }
  );

  const result = await (async () => {
    try {
      return await prismaClient.apiKey.updateMany({
        where: {
          id: apiKeyId,
          runtimeEnvironmentId: environment.id,
          issuedBy: "USER",
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { presetId: prepared.policy.presetId, scopes: prepared.policy.scopes },
      });
    } catch (error) {
      telemetryRecorder.recordOperation("update_access", "error", "database_error");
      throw error;
    }
  })();

  if (result.count !== 1) {
    reject(uneditableApiKeyReason(await findApiKey()) ?? MISSING_API_KEY);
  }

  telemetryRecorder.recordOperation("update_access", "success");
  logger.info("API key access updated", {
    apiKeyId,
    environmentId: environment.id,
    userId,
    fromPresetId: current.presetId,
    toPresetId: prepared.policy.presetId,
    added: prepared.policy.scopes.filter((scope) => !current.scopes.includes(scope)),
    removed: current.scopes.filter((scope) => !prepared.policy.scopes.includes(scope)),
  });
  return prepared.policy;
}

type UneditableApiKey = { reason: "not_found_or_revoked" | "expired"; message: string };

const MISSING_API_KEY: UneditableApiKey = {
  reason: "not_found_or_revoked",
  message: MISSING_API_KEY_MESSAGE,
};

function uneditableApiKeyReason(
  apiKey: { revokedAt: Date | null; expiresAt: Date | null } | null
): UneditableApiKey | undefined {
  if (!apiKey) {
    return MISSING_API_KEY;
  }
  if (apiKey.revokedAt) {
    return {
      reason: "not_found_or_revoked",
      message: REVOKED_API_KEY_MESSAGE,
    };
  }
  if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
    return { reason: "expired", message: EXPIRED_API_KEY_MESSAGE };
  }
  return undefined;
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
          issuedBy: "USER",
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

/** Replace the IP ranges an API key may be used from. An empty list allows any IP. */
export async function updateEnvironmentApiKeyIpRanges(
  {
    environmentId,
    apiKeyId,
    allowedIpRanges,
  }: {
    environmentId: string;
    apiKeyId: string;
    allowedIpRanges: string[];
  },
  {
    prismaClient = prisma,
    telemetryRecorder = apiKeyTelemetry,
    allowPrivateIpRanges = env.API_KEY_ALLOW_PRIVATE_IP_RANGES,
  }: {
    prismaClient?: Pick<PrismaClient, "apiKey">;
    telemetryRecorder?: ApiKeyTelemetry;
    allowPrivateIpRanges?: boolean;
  } = {}
): Promise<string[]> {
  const ipRanges = parseIpRanges(allowedIpRanges, { allowNonPublicRanges: allowPrivateIpRanges });
  if (!ipRanges.ok) {
    telemetryRecorder.recordOperation("update_ip_ranges", "rejected", "invalid_ip_ranges");
    throw new Error(ipRanges.error);
  }

  const result = await (async () => {
    try {
      return await prismaClient.apiKey.updateMany({
        where: {
          id: apiKeyId,
          runtimeEnvironmentId: environmentId,
          issuedBy: "USER",
          revokedAt: null,
        },
        data: { allowedIpRanges: ipRanges.ranges },
      });
    } catch (error) {
      telemetryRecorder.recordOperation("update_ip_ranges", "error", "database_error");
      throw error;
    }
  })();

  if (result.count !== 1) {
    telemetryRecorder.recordOperation("update_ip_ranges", "rejected", "not_found_or_revoked");
    throw new Error("API key not found or already revoked");
  }

  telemetryRecorder.recordOperation("update_ip_ranges", "success");
  return ipRanges.ranges;
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

/** Set or clear an API key's note. Changes nothing else about the key. */
export async function updateEnvironmentApiKeyDescription(
  {
    environmentId,
    apiKeyId,
    description,
  }: {
    environmentId: string;
    apiKeyId: string;
    description: string | null;
  },
  {
    prismaClient = prisma,
    telemetryRecorder = apiKeyTelemetry,
  }: {
    prismaClient?: Pick<PrismaClient, "apiKey">;
    telemetryRecorder?: ApiKeyTelemetry;
  } = {}
): Promise<string | null> {
  const note = normalizeApiKeyNote(description);
  if (note !== null && note.length > API_KEY_NOTE_MAX_LENGTH) {
    telemetryRecorder.recordOperation("update_description", "rejected", "invalid_description");
    throw new Error(API_KEY_NOTE_TOO_LONG_MESSAGE);
  }

  const result = await (async () => {
    try {
      return await prismaClient.apiKey.updateMany({
        where: {
          id: apiKeyId,
          runtimeEnvironmentId: environmentId,
          issuedBy: "USER",
          revokedAt: null,
        },
        data: { description: note },
      });
    } catch (error) {
      telemetryRecorder.recordOperation("update_description", "error", "database_error");
      throw error;
    }
  })();

  if (result.count !== 1) {
    telemetryRecorder.recordOperation("update_description", "rejected", "not_found_or_revoked");
    throw new Error("API key not found or already revoked");
  }

  telemetryRecorder.recordOperation("update_description", "success");
  return note;
}
