import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  type Repository,
  type Tag,
  RepositoryNotFoundException,
  GetAuthorizationTokenCommand,
  PutLifecyclePolicyCommand,
  PutImageTagMutabilityCommand,
} from "@aws-sdk/client-ecr";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";
import { type RegistryConfig } from "./registryConfig.server";
import type { EnvironmentType } from "@trigger.dev/core/v3";

// Optional configuration for cross-account access
export type AssumeRoleConfig = {
  roleArn?: string;
  externalId?: string;
};

async function getAssumedRoleCredentials({
  region,
  assumeRole,
}: {
  region: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}> {
  const sts = new STSClient({ region });

  // Generate a unique session name using timestamp and random string
  // This helps with debugging but doesn't affect concurrent sessions
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sessionName = `TriggerWebappECRAccess_${timestamp}_${randomSuffix}`;

  const [error, response] = await tryCatch(
    sts.send(
      new AssumeRoleCommand({
        RoleArn: assumeRole?.roleArn,
        RoleSessionName: sessionName,
        // Sessions automatically expire after 1 hour
        // AWS allows 5000 concurrent sessions by default
        DurationSeconds: 3600,
        ExternalId: assumeRole?.externalId,
      })
    )
  );

  if (error) {
    logger.error("Failed to assume role", {
      assumeRole,
      sessionName,
      error: error.message,
    });
    throw error;
  }

  if (!response.Credentials) {
    throw new Error("STS: No credentials returned from assumed role");
  }

  if (
    !response.Credentials.AccessKeyId ||
    !response.Credentials.SecretAccessKey ||
    !response.Credentials.SessionToken
  ) {
    throw new Error("STS: Invalid credentials returned from assumed role");
  }

  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
}

export async function createEcrClient({
  region,
  assumeRole,
}: {
  region: string;
  assumeRole?: AssumeRoleConfig;
}) {
  if (!assumeRole) {
    return new ECRClient({ region });
  }

  // Get credentials for cross-account access
  const credentials = await getAssumedRoleCredentials({ region, assumeRole });
  return new ECRClient({
    region,
    credentials,
  });
}

export async function getDeploymentImageRef({
  registry,
  projectRef,
  nextVersion,
  environmentType,
  deploymentShortCode,
}: {
  registry: RegistryConfig;
  projectRef: string;
  nextVersion: string;
  environmentType: EnvironmentType;
  deploymentShortCode: string;
}): Promise<{
  imageRef: string;
  isEcr: boolean;
  repoCreated: boolean;
}> {
  const repositoryName = `${registry.namespace}/${projectRef}`;
  const envType = environmentType.toLowerCase();
  const imageRef = `${registry.host}/${repositoryName}:${nextVersion}.${envType}.${deploymentShortCode}`;

  if (!isEcrRegistry(registry.host)) {
    return {
      imageRef,
      isEcr: false,
      repoCreated: false,
    };
  }

  const [ecrRepoError, ecrData] = await tryCatch(
    ensureEcrRepositoryExists({
      repositoryName,
      registryHost: registry.host,
      registryTags: registry.ecrTags,
      assumeRole: {
        roleArn: registry.ecrAssumeRoleArn,
        externalId: registry.ecrAssumeRoleExternalId,
      },
    })
  );

  if (ecrRepoError) {
    logger.error("Failed to ensure ECR repository exists", {
      repositoryName,
      host: registry.host,
      ecrRepoError: ecrRepoError.message,
    });
    throw ecrRepoError;
  }

  return {
    imageRef,
    isEcr: true,
    repoCreated: ecrData.repoCreated,
  };
}

export function isEcrRegistry(registryHost: string) {
  try {
    parseEcrRegistryDomain(registryHost);
    return true;
  } catch {
    return false;
  }
}

export function parseRegistryTags(tags: string): Tag[] {
  if (!tags) {
    return [];
  }

  return tags
    .split(",")
    .map((t) => {
      const tag = t.trim();
      if (tag.length === 0) {
        return null;
      }

      // If there's no '=' in the tag, treat the whole tag as the key with an empty value
      const equalIndex = tag.indexOf("=");
      const key = equalIndex === -1 ? tag : tag.slice(0, equalIndex);
      const value = equalIndex === -1 ? "" : tag.slice(equalIndex + 1);

      if (key.trim().length === 0) {
        logger.warn("Invalid ECR tag format (empty key), skipping tag", { tag: t });
        return null;
      }

      return {
        Key: key.trim(),
        Value: value.trim(),
      } as Tag;
    })
    .filter((tag): tag is Tag => tag !== null);
}

const untaggedImageExpirationPolicy = JSON.stringify({
  rules: [
    {
      rulePriority: 1,
      description: "Expire untagged images older than 3 days",
      selection: {
        tagStatus: "untagged",
        countType: "sinceImagePushed",
        countUnit: "days",
        countNumber: 3,
      },
      action: { type: "expire" },
    },
  ],
});

async function createEcrRepository({
  repositoryName,
  region,
  accountId,
  registryTags,
  assumeRole,
}: {
  repositoryName: string;
  region: string;
  accountId?: string;
  registryTags?: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<Repository> {
  const ecr = await createEcrClient({ region, assumeRole });

  const result = await ecr.send(
    new CreateRepositoryCommand({
      repositoryName,
      imageTagMutability: "IMMUTABLE_WITH_EXCLUSION",
      imageTagMutabilityExclusionFilters: [
        {
          // only the `cache` tag will be mutable, all other tags will be immutable
          filter: "cache",
          filterType: "WILDCARD",
        },
      ],
      encryptionConfiguration: {
        encryptionType: "AES256",
      },
      registryId: accountId,
      tags: registryTags ? parseRegistryTags(registryTags) : undefined,
    })
  );

  if (!result.repository) {
    logger.error("Failed to create ECR repository", { repositoryName, result });
    throw new Error(`Failed to create ECR repository: ${repositoryName}`);
  }

  // When the `cache` tag is mutated, the old cache images are untagged.
  // This policy matches those images and expires them to avoid bloating the repository.
  await ecr.send(
    new PutLifecyclePolicyCommand({
      repositoryName: result.repository.repositoryName,
      registryId: result.repository.registryId,
      lifecyclePolicyText: untaggedImageExpirationPolicy,
    })
  );

  return result.repository;
}

async function updateEcrRepositoryCacheSettings({
  repositoryName,
  region,
  accountId,
  assumeRole,
}: {
  repositoryName: string;
  region: string;
  accountId?: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<void> {
  logger.debug("Updating ECR repository tag mutability to IMMUTABLE_WITH_EXCLUSION", {
    repositoryName,
    region,
  });

  const ecr = await createEcrClient({ region, assumeRole });

  await ecr.send(
    new PutImageTagMutabilityCommand({
      repositoryName,
      registryId: accountId,
      imageTagMutability: "IMMUTABLE_WITH_EXCLUSION",
      imageTagMutabilityExclusionFilters: [
        {
          // only the `cache` tag will be mutable, all other tags will be immutable
          filter: "cache",
          filterType: "WILDCARD",
        },
      ],
    })
  );

  // When the `cache` tag is mutated, the old cache images are untagged.
  // This policy matches those images and expires them to avoid bloating the repository.
  await ecr.send(
    new PutLifecyclePolicyCommand({
      repositoryName,
      registryId: accountId,
      lifecyclePolicyText: untaggedImageExpirationPolicy,
    })
  );

  logger.debug("Successfully updated ECR repository to IMMUTABLE_WITH_EXCLUSION", {
    repositoryName,
    region,
  });
}

async function getEcrRepository({
  repositoryName,
  region,
  accountId,
  assumeRole,
}: {
  repositoryName: string;
  region: string;
  accountId?: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<Repository | undefined> {
  const ecr = await createEcrClient({ region, assumeRole });

  try {
    const result = await ecr.send(
      new DescribeRepositoriesCommand({
        repositoryNames: [repositoryName],
        registryId: accountId,
      })
    );

    if (!result.repositories || result.repositories.length === 0) {
      logger.debug("ECR repository not found", { repositoryName, region, result });
      return undefined;
    }

    return result.repositories[0];
  } catch (error) {
    if (error instanceof RepositoryNotFoundException) {
      logger.debug("ECR repository not found: RepositoryNotFoundException", {
        repositoryName,
        region,
      });
      return undefined;
    }
    throw error;
  }
}

export type EcrRegistryComponents = {
  accountId: string;
  region: string;
};

export function parseEcrRegistryDomain(registryHost: string): EcrRegistryComponents {
  const parts = registryHost.split(".");

  const isValid =
    parts.length === 6 &&
    parts[1] === "dkr" &&
    parts[2] === "ecr" &&
    parts[4] === "amazonaws" &&
    parts[5] === "com";

  if (!isValid) {
    throw new Error(`Invalid ECR registry host: ${registryHost}`);
  }

  return {
    accountId: parts[0],
    region: parts[3],
  };
}

async function ensureEcrRepositoryExists({
  repositoryName,
  registryHost,
  registryTags,
  assumeRole,
}: {
  repositoryName: string;
  registryHost: string;
  registryTags?: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<{ repo: Repository; repoCreated: boolean }> {
  const { region, accountId } = parseEcrRegistryDomain(registryHost);

  const [getRepoError, existingRepo] = await tryCatch(
    getEcrRepository({ repositoryName, region, accountId, assumeRole })
  );

  if (getRepoError) {
    logger.error("Failed to get ECR repository", { repositoryName, region, getRepoError });
    throw getRepoError;
  }

  if (existingRepo) {
    logger.debug("ECR repository already exists", { repositoryName, region, existingRepo });

    // check if the repository is missing the cache settings
    if (existingRepo.imageTagMutability === "IMMUTABLE") {
      const [updateError] = await tryCatch(
        updateEcrRepositoryCacheSettings({ repositoryName, region, accountId, assumeRole })
      );

      if (updateError) {
        logger.error("Failed to update ECR repository cache settings", {
          repositoryName,
          region,
          updateError,
        });
      }
    }

    return {
      repo: existingRepo,
      repoCreated: false,
    };
  }

  const [createRepoError, newRepo] = await tryCatch(
    createEcrRepository({ repositoryName, region, accountId, registryTags, assumeRole })
  );

  if (createRepoError) {
    logger.error("Failed to create ECR repository", { repositoryName, region, createRepoError });
    throw createRepoError;
  }

  if (newRepo.repositoryName !== repositoryName) {
    logger.error("ECR repository name mismatch", { repositoryName, region, newRepo });
    throw new Error(
      `ECR repository name mismatch: ${repositoryName} !== ${newRepo.repositoryName}`
    );
  }

  return {
    repo: newRepo,
    repoCreated: true,
  };
}

export async function getEcrAuthToken({
  registryHost,
  assumeRole,
}: {
  registryHost: string;
  assumeRole?: AssumeRoleConfig;
}): Promise<{ username: string; password: string }> {
  const { region, accountId } = parseEcrRegistryDomain(registryHost);
  if (!region) {
    logger.error("Invalid ECR registry host", { registryHost });
    throw new Error("Invalid ECR registry host");
  }

  const ecr = await createEcrClient({ region, assumeRole });
  const response = await ecr.send(
    new GetAuthorizationTokenCommand({
      registryIds: accountId ? [accountId] : undefined,
    })
  );

  if (!response.authorizationData) {
    throw new Error("Failed to get ECR authorization token");
  }

  const authData = response.authorizationData[0];

  if (!authData.authorizationToken) {
    throw new Error("No authorization token returned from ECR");
  }

  const authToken = Buffer.from(authData.authorizationToken, "base64").toString();
  const [username, password] = authToken.split(":");

  return { username, password };
}
