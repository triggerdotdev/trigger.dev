import { BackgroundTaskMetadata } from "@trigger.dev/core";
import type { BackgroundTaskVersion, Endpoint } from "@trigger.dev/database";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "~/consts";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import {
  createBackgroundTaskSecret,
  deleteBackgroundTaskSecret,
  updateBackgroundTaskSecret,
} from "~/models/backgroundTaskSecret.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export class RegisterBackgroundTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    metadata: BackgroundTaskMetadata
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#upsertBackgroundTask(endpoint, endpoint.environment, metadata);
  }

  async #upsertBackgroundTask(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: BackgroundTaskMetadata
  ): Promise<BackgroundTaskVersion | undefined> {
    // Check the background task doesn't already exist and is deleted
    const existingBackgroundTask = await this.#prismaClient.backgroundTask.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: metadata.id,
        },
      },
    });

    if (existingBackgroundTask && existingBackgroundTask.deletedAt && !metadata.enabled) {
      return;
    }

    const backgroundTask = await this.#prismaClient.backgroundTask.upsert({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: metadata.id,
        },
      },
      create: {
        organization: {
          connect: {
            id: environment.organizationId,
          },
        },
        project: {
          connect: {
            id: environment.projectId,
          },
        },
        slug: metadata.id,
        title: metadata.name,
      },
      update: {
        title: metadata.name,
        deletedAt: metadata.enabled ? null : undefined,
      },
    });

    const backgroundTaskVersion = await this.#prismaClient.backgroundTaskVersion.upsert({
      where: {
        backgroundTaskId_version_environmentId: {
          backgroundTaskId: backgroundTask.id,
          version: metadata.version,
          environmentId: environment.id,
        },
      },
      create: {
        backgroundTask: {
          connect: {
            id: backgroundTask.id,
          },
        },
        endpoint: {
          connect: {
            id: endpoint.id,
          },
        },
        environment: {
          connect: {
            id: environment.id,
          },
        },
        organization: {
          connect: {
            id: environment.organizationId,
          },
        },
        project: {
          connect: {
            id: environment.projectId,
          },
        },
        version: metadata.version,
        cpu: metadata.cpu,
        memory: metadata.memory,
        concurrency: metadata.concurrency ?? DEFAULT_MAX_CONCURRENT_RUNS,
      },
      update: {
        cpu: metadata.cpu,
        memory: metadata.memory,
        concurrency: metadata.concurrency ?? DEFAULT_MAX_CONCURRENT_RUNS,
        endpoint: {
          connect: {
            id: endpoint.id,
          },
        },
      },
    });

    // Count the number of job instances that have higher version numbers
    const laterVersionCount = await this.#prismaClient.backgroundTaskVersion.count({
      where: {
        backgroundTaskId: backgroundTask.id,
        version: {
          gt: metadata.version,
        },
        environmentId: environment.id,
      },
    });

    // If there are no later versions, then we can upsert the latest BackgroundTaskAlias
    if (laterVersionCount === 0) {
      await this.#prismaClient.backgroundTaskAlias.upsert({
        where: {
          backgroundTaskId_environmentId_name: {
            backgroundTaskId: backgroundTask.id,
            environmentId: environment.id,
            name: "latest",
          },
        },
        create: {
          backgroundTaskId: backgroundTask.id,
          versionId: backgroundTaskVersion.id,
          environmentId: environment.id,
          name: "latest",
          value: backgroundTaskVersion.version,
        },
        update: {
          versionId: backgroundTaskVersion.id,
          value: backgroundTaskVersion.version,
        },
      });
    }

    // Now we need to register the background task secrets
    // 1. Add new secrets
    // 2. Remove old secrets
    // 3. Update existing secrets

    const existingSecrets = await this.#prismaClient.backgroundTaskSecret.findMany({
      where: {
        backgroundTaskVersionId: backgroundTaskVersion.id,
      },
      select: {
        id: true,
        key: true,
      },
    });

    const metadataSecrets = metadata.secrets ?? {};

    const existingSecretKeys = existingSecrets.map((s) => s.key);
    const newSecretKeys = Object.keys(metadataSecrets);

    const secretsToRemove = existingSecrets.filter((s) => !newSecretKeys.includes(s.key));
    const secretsToCreate = newSecretKeys.filter((k) => !existingSecretKeys.includes(k));
    const secretsToUpdate = newSecretKeys.filter((k) => existingSecretKeys.includes(k));

    // 1. Add new secrets
    for (const secretKey of secretsToCreate) {
      await createBackgroundTaskSecret(
        this.#prismaClient,
        backgroundTaskVersion,
        secretKey,
        metadataSecrets[secretKey]
      );
    }

    // 2. Remove old secrets
    for (const secret of secretsToRemove) {
      await deleteBackgroundTaskSecret(this.#prismaClient, secret.id);
    }

    // 3. Update existing secrets
    for (const secretKey of secretsToUpdate) {
      await updateBackgroundTaskSecret(
        this.#prismaClient,
        backgroundTaskVersion,
        secretKey,
        metadataSecrets[secretKey]
      );
    }

    return backgroundTaskVersion;
  }
}
