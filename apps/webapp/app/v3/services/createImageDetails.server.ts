import { CreateImageDetailsRequestBody } from "@trigger.dev/core/v3";
import type { ImageDetails } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { env } from "~/env.server";
import { workerQueue } from "~/services/worker.server";

function escapeStringForRegex(rawString: string) {
  return rawString.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

export class CreateImageDetailsService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    projectRef: string,
    environment: AuthenticatedEnvironment,
    body: CreateImageDetailsRequestBody
  ): Promise<ImageDetails> {
    const allowedTagPrefix = escapeStringForRegex(`${env.IMAGE_REGISTRY}/${env.IMAGE_REPO}:`);

    if (!body.metadata.imageTag.match(`^${allowedTagPrefix}`)) {
      if (env.NODE_ENV !== "development") {
        throw new Error("Forbidden image tag");
      }
    }

    const project = await this.#prismaClient.project.findUniqueOrThrow({
      where: {
        externalRef: projectRef,
        environments: {
          some: {
            id: environment.id,
          },
        },
      },
    });

    logger.debug(`Creating image details`, {
      imageTag: body.metadata.imageTag,
    });

    const imageDetails = await this.#prismaClient.imageDetails.upsert({
      where: {
        projectId_runtimeEnvironmentId_contentHash: {
          contentHash: body.metadata.contentHash,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
        },
      },
      create: {
        contentHash: body.metadata.contentHash,
        friendlyId: generateFriendlyId("image"),
        tag: body.metadata.imageTag,
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        metadata: body.metadata,
      },
      update: {
        tag: body.metadata.imageTag,
        metadata: body.metadata,
      },
    });

    await workerQueue.enqueue("indexTasks", { id: imageDetails.id });

    return imageDetails;
  }
}
