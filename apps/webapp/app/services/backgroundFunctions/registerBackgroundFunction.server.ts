import { BackgroundFunctionMetadata } from "@trigger.dev/core";
import type { BackgroundFunctionVersion, Endpoint } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export class RegisterBackgroundFunctionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    metadata: BackgroundFunctionMetadata
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#upsertBackgroundFunction(endpoint, endpoint.environment, metadata);
  }

  async #upsertBackgroundFunction(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: BackgroundFunctionMetadata
  ): Promise<BackgroundFunctionVersion | undefined> {
    // Check the background task doesn't already exist and is deleted
    const existingBackgroundFunction = await this.#prismaClient.backgroundFunction.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: metadata.id,
        },
      },
    });

    if (existingBackgroundFunction && existingBackgroundFunction.deletedAt && !metadata.enabled) {
      return;
    }

    const backgroundFunction = await this.#prismaClient.backgroundFunction.upsert({
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

    const backgroundFunctionVersion = await this.#prismaClient.backgroundFunctionVersion.upsert({
      where: {
        backgroundFunctionId_version_environmentId: {
          backgroundFunctionId: backgroundFunction.id,
          version: metadata.version,
          environmentId: environment.id,
        },
      },
      create: {
        backgroundFunction: {
          connect: {
            id: backgroundFunction.id,
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
      },
      update: {
        endpoint: {
          connect: {
            id: endpoint.id,
          },
        },
      },
    });

    // Count the number of job instances that have higher version numbers
    const laterVersionCount = await this.#prismaClient.backgroundFunctionVersion.count({
      where: {
        backgroundFunctionId: backgroundFunction.id,
        version: {
          gt: metadata.version,
        },
        environmentId: environment.id,
      },
    });

    // If there are no later versions, then we can upsert the latest BackgroundFunctionAlias
    if (laterVersionCount === 0) {
      await this.#prismaClient.backgroundFunctionAlias.upsert({
        where: {
          backgroundFunctionId_environmentId_name: {
            backgroundFunctionId: backgroundFunction.id,
            environmentId: environment.id,
            name: "latest",
          },
        },
        create: {
          backgroundFunctionId: backgroundFunction.id,
          versionId: backgroundFunctionVersion.id,
          environmentId: environment.id,
          name: "latest",
          value: backgroundFunctionVersion.version,
        },
        update: {
          versionId: backgroundFunctionVersion.id,
          value: backgroundFunctionVersion.version,
        },
      });
    }

    return backgroundFunctionVersion;
  }
}
