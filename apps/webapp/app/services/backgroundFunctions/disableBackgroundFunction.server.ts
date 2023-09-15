import type { BackgroundFunctionVersion } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";

export type DisableBackgroundFunctionServiceOptions = {
  slug: string;
  version: string;
};

export class DisableBackgroundFunctionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    options: DisableBackgroundFunctionServiceOptions
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#disableBackgroundFunction(endpoint.environment, options);
  }

  async #disableBackgroundFunction(
    environment: AuthenticatedEnvironment,
    options: DisableBackgroundFunctionServiceOptions
  ): Promise<BackgroundFunctionVersion | undefined> {
    const backgroundFunction = await this.#prismaClient.backgroundFunction.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: options.slug,
        },
      },
    });

    if (!backgroundFunction) {
      return;
    }

    const backgroundFunctionVersion = await this.#prismaClient.backgroundFunctionVersion.findUnique(
      {
        where: {
          backgroundFunctionId_version_environmentId: {
            backgroundFunctionId: backgroundFunction.id,
            version: options.version,
            environmentId: environment.id,
          },
        },
      }
    );

    if (!backgroundFunctionVersion) {
      return;
    }

    // TODO: Disable background task
  }
}
