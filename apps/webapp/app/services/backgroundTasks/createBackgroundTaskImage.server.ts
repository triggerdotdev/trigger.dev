import { CreateBackgroundTaskImageRequestBody } from "@trigger.dev/core";
import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { backgroundTaskProvider } from "./provider.server";

export class CreateBackgroundTaskImageService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    id: string,
    payload: CreateBackgroundTaskImageRequestBody
  ) {
    // Find the artifact
    const artifact = await this.#prismaClient.backgroundTaskArtifact.findUnique({
      where: {
        id,
      },
      include: {
        backgroundTask: true,
      },
    });

    if (!artifact) {
      return;
    }

    if (artifact.backgroundTask.projectId !== environment.projectId) {
      return;
    }

    const image = await this.#prismaClient.backgroundTaskImage.upsert({
      where: {
        backgroundTaskArtifactId_digest: {
          backgroundTaskArtifactId: artifact.id,
          digest: payload.digest,
        },
      },
      create: {
        backgroundTaskArtifactId: artifact.id,
        backgroundTaskId: artifact.backgroundTaskId,
        digest: payload.digest,
        name: payload.name,
        tag: payload.tag,
        size: payload.size,
        provider: backgroundTaskProvider.name,
      },
      update: {
        name: payload.name,
        tag: payload.tag,
        size: payload.size,
      },
    });

    return image;
  }
}
