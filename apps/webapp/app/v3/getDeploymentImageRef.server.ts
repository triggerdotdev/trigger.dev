import {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  type Repository,
  type Tag,
  RepositoryNotFoundException,
  GetAuthorizationTokenCommand,
} from "@aws-sdk/client-ecr";
import { tryCatch } from "@trigger.dev/core";
import { logger } from "~/services/logger.server";

export async function getDeploymentImageRef({
  host,
  namespace,
  projectRef,
  nextVersion,
  environmentSlug,
  registryId,
  registryTags,
}: {
  host: string;
  namespace: string;
  projectRef: string;
  nextVersion: string;
  environmentSlug: string;
  registryId?: string;
  registryTags?: string;
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
    ensureEcrRepositoryExists({ repositoryName, registryHost: host, registryId, registryTags })
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
}: {
  repositoryName: string;
  region: string;
  registryId?: string;
  registryTags?: string;
}): Promise<Repository> {
  const ecr = new ECRClient({ region });

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
}: {
  repositoryName: string;
  region: string;
  registryId?: string;
}): Promise<Repository | undefined> {
  const ecr = new ECRClient({ region });

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
}: {
  repositoryName: string;
  registryHost: string;
  registryId?: string;
  registryTags?: string;
}): Promise<Repository> {
  const region = getEcrRegion(registryHost);

  if (!region) {
    throw new Error(`Invalid ECR registry host: ${registryHost}`);
  }

  const [getRepoError, existingRepo] = await tryCatch(
    getEcrRepository({ repositoryName, region, registryId })
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
    createEcrRepository({ repositoryName, region, registryId, registryTags })
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
}: {
  registryHost: string;
  registryId?: string;
}): Promise<{ username: string; password: string }> {
  const region = getEcrRegion(registryHost);
  if (!region) {
    logger.error("Invalid ECR registry host", { registryHost });
    throw new Error("Invalid ECR registry host");
  }

  const ecr = new ECRClient({ region });
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
