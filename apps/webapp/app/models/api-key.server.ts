import type { RuntimeEnvironment } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { customAlphabet } from "nanoid";
import { RuntimeEnvironmentType } from "~/database-types";

const apiKeyId = customAlphabet(
  "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  12
);

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

  const updatedEnviroment = await prisma.runtimeEnvironment.update({
    data: {
      apiKey: newApiKey,
      pkApiKey: newPkApiKey,
    },
    where: {
      id: environmentId,
    },
  });

  return updatedEnviroment;
}

export function createApiKeyForEnv(envType: RuntimeEnvironment["type"]) {
  return `tr_${envSlug(envType)}_${apiKeyId(20)}`;
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
