import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  type Repository,
  type Tag,
  RepositoryNotFoundException,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";

// Optional configuration for cross-account access
export type CrossAccountConfig = {
  assumeRole: boolean;
  roleName: string;
};

const DEFAULT_CROSS_ACCOUNT_CONFIG: CrossAccountConfig = {
  assumeRole: false,
  roleName: "OrganizationAccountAccessRole",
};

async function getAssumedRoleCredentials(
  region: string,
  accountId: string,
  config: CrossAccountConfig
): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}> {
  const sts = new STSClient({ region });
  const roleArn = `arn:aws:iam::${accountId}:role/${config.roleName}`;

  // Generate a unique session name using timestamp and random string
  // This helps with debugging but doesn't affect concurrent sessions
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sessionName = `TriggerWebappECRAccess_${timestamp}_${randomSuffix}`;

  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        // Sessions automatically expire after 1 hour
        // AWS allows 5000 concurrent sessions by default
        DurationSeconds: 3600,
      })
    );

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
  } catch (error) {
    logger.error("Failed to assume role", { roleArn, sessionName, error });
    throw error;
  }
}

async function createEcrClient(
  region: string,
  registryId?: string,
  crossAccountConfig: CrossAccountConfig = DEFAULT_CROSS_ACCOUNT_CONFIG
) {
  // If no registryId or role assumption is disabled, use default credentials
  if (!registryId || !crossAccountConfig.assumeRole) {
    return new ECRClient({ region });
  }

  // Get credentials for cross-account access
  const credentials = await getAssumedRoleCredentials(region, registryId, crossAccountConfig);
  return new ECRClient({
    region,
    credentials,
  });
}

export async function getDeploymentImageRef({
  host,
  namespace,
  projectRef,
  nextVersion,
  environmentSlug,
  registryId,
  registryTags,
  crossAccountConfig,
}: {
  host: string;
  namespace: string;
  projectRef: string;
  nextVersion: string;
  environmentSlug: string;
  registryId?: string;
  registryTags?: string;
  crossAccountConfig?: CrossAccountConfig;
}): Promise<{
  imageRef: string;
  isEcr: boolean;
}> {
  const repositoryName = `${namespace}/${projectRef}`;
  const imageRef = `${host}/${repositoryName}:${nextVersion}.${environmentSlug}`;

  if (!isEcrRegistry(host)) {
    return {
      imageRef,
      isEcr: false,
    };
  }

  const [ecrRepoError] = await tryCatch(
    ensureEcrRepositoryExists({
      repositoryName,
      registryHost: host,
      registryId,
      registryTags,
      crossAccountConfig,
    })
  );

  if (ecrRepoError) {
    logger.error("Failed to ensure ECR repository exists", {
      repositoryName,
      host,
      ecrRepoError: ecrRepoError.message,
    });
    throw ecrRepoError;
  }

  return {
    imageRef,
    isEcr: true,
  };
}

export function isEcrRegistry(registryHost: string) {
  return registryHost.includes("amazonaws.com");
}

function parseRegistryTags(tags: string): Tag[] {
  return tags.split(",").map((tag) => {
    const [key, value] = tag.split("=");
    return { Key: key, Value: value };
  });
}

async function createEcrRepository({
  repositoryName,
  region,
  registryId,
  registryTags,
  crossAccountConfig,
}: {
  repositoryName: string;
  region: string;
  registryId?: string;
  registryTags?: string;
  crossAccountConfig?: CrossAccountConfig;
}): Promise<Repository> {
  const ecr = await createEcrClient(region, registryId, crossAccountConfig);

  const result = await ecr.send(
    new CreateRepositoryCommand({
      repositoryName,
      imageTagMutability: "IMMUTABLE",
      encryptionConfiguration: {
        encryptionType: "AES256",
      },
      registryId,
      tags: registryTags ? parseRegistryTags(registryTags) : undefined,
    })
  );

  if (!result.repository) {
    logger.error("Failed to create ECR repository", { repositoryName, result });
    throw new Error(`Failed to create ECR repository: ${repositoryName}`);
  }

  return result.repository;
}

async function getEcrRepository({
  repositoryName,
  region,
  registryId,
  crossAccountConfig,
}: {
  repositoryName: string;
  region: string;
  registryId?: string;
  crossAccountConfig?: CrossAccountConfig;
}): Promise<Repository | undefined> {
  const ecr = await createEcrClient(region, registryId, crossAccountConfig);

  try {
    const result = await ecr.send(
      new DescribeRepositoriesCommand({
        repositoryNames: [repositoryName],
        registryId,
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

export function getEcrRegion(registryHost: string): string | undefined {
  const parts = registryHost.split(".");
  if (parts.length !== 6 || parts[1] !== "dkr" || parts[2] !== "ecr") {
    return undefined;
  }
  return parts[3];
}

async function ensureEcrRepositoryExists({
  repositoryName,
  registryHost,
  registryId,
  registryTags,
  crossAccountConfig,
}: {
  repositoryName: string;
  registryHost: string;
  registryId?: string;
  registryTags?: string;
  crossAccountConfig?: CrossAccountConfig;
}): Promise<Repository> {
  const region = getEcrRegion(registryHost);

  if (!region) {
    throw new Error(`Invalid ECR registry host: ${registryHost}`);
  }

  const [getRepoError, existingRepo] = await tryCatch(
    getEcrRepository({ repositoryName, region, registryId, crossAccountConfig })
  );

  if (getRepoError) {
    logger.error("Failed to get ECR repository", { repositoryName, region, getRepoError });
    throw getRepoError;
  }

  if (existingRepo) {
    logger.debug("ECR repository already exists", { repositoryName, region, existingRepo });
    return existingRepo;
  }

  const [createRepoError, newRepo] = await tryCatch(
    createEcrRepository({ repositoryName, region, registryId, registryTags, crossAccountConfig })
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

  return newRepo;
}

export async function getEcrAuthToken({
  registryHost,
  registryId,
  crossAccountConfig,
}: {
  registryHost: string;
  registryId?: string;
  crossAccountConfig?: CrossAccountConfig;
}): Promise<{ username: string; password: string }> {
  const region = getEcrRegion(registryHost);
  if (!region) {
    logger.error("Invalid ECR registry host", { registryHost });
    throw new Error("Invalid ECR registry host");
  }

  const ecr = await createEcrClient(region, registryId, crossAccountConfig);
  const response = await ecr.send(
    new GetAuthorizationTokenCommand({
      registryIds: registryId ? [registryId] : undefined,
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
