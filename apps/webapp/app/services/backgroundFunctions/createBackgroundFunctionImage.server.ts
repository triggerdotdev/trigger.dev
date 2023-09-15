import { CreateBackgroundFunctionWorkerImageRequestBody } from "@trigger.dev/core";
import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";

export class CreateBackgroundFunctionImageService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    id: string,
    payload: CreateBackgroundFunctionWorkerImageRequestBody
  ) {
    // Find the artifact
    const artifact = await this.#prismaClient.backgroundFunctionArtifact.findUnique({
      where: {
        id,
      },
      include: {
        backgroundFunction: true,
      },
    });

    if (!artifact) {
      return;
    }

    if (artifact.backgroundFunction.projectId !== environment.projectId) {
      return;
    }

    const image = await this.#prismaClient.backgroundFunctionImage.upsert({
      where: {
        backgroundFunctionArtifactId_digest: {
          backgroundFunctionArtifactId: artifact.id,
          digest: payload.digest,
        },
      },
      create: {
        backgroundFunctionArtifactId: artifact.id,
        backgroundFunctionId: artifact.backgroundFunctionId,
        digest: payload.digest,
        name: payload.name,
        tag: payload.tag,
        size: payload.size,
        registry: payload.registry,
      },
      update: {
        name: payload.name,
        tag: payload.tag,
        size: payload.size,
        registry: payload.registry,
      },
    });

    return image;
  }
}
