import type { BackgroundTaskVersion } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export type DisableBackgroundTaskServiceOptions = {
  slug: string;
  version: string;
};

export class DisableBackgroundTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    options: DisableBackgroundTaskServiceOptions
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#disableBackgroundTask(endpoint.environment, options);
  }

  async #disableBackgroundTask(
    environment: AuthenticatedEnvironment,
    options: DisableBackgroundTaskServiceOptions
  ): Promise<BackgroundTaskVersion | undefined> {
    const backgroundTask = await this.#prismaClient.backgroundTask.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: options.slug,
        },
      },
    });

    if (!backgroundTask) {
      return;
    }

    const backgroundTaskVersion = await this.#prismaClient.backgroundTaskVersion.findUnique({
      where: {
        backgroundTaskId_version_environmentId: {
          backgroundTaskId: backgroundTask.id,
          version: options.version,
          environmentId: environment.id,
        },
      },
    });

    if (!backgroundTaskVersion) {
      return;
    }

    // TODO: Disable background task
  }
}
