import { BackgroundTaskArtifact, PrismaClient } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { DeployBackgroundTaskRequestBody } from "@trigger.dev/core";
import { prisma } from "~/db.server";
import nodeCrypto from "node:crypto";

export class DeployBackgroundTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    payload: DeployBackgroundTaskRequestBody
  ): Promise<BackgroundTaskArtifact | undefined> {
    const hash = this.#hashPayload(payload);

    const backgroundTask = await this.#prismaClient.backgroundTask.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: payload.id,
        },
      },
    });

    if (!backgroundTask) {
      return;
    }

    return this.#prismaClient.backgroundTaskArtifact.upsert({
      where: {
        backgroundTaskId_version_hash: {
          backgroundTaskId: backgroundTask.id,
          version: payload.version,
          hash,
        },
      },
      create: {
        backgroundTaskId: backgroundTask.id,
        fileName: payload.fileName,
        version: payload.version,
        hash,
        bundle: payload.bundle,
        nodeVersion: payload.nodeVersion,
        dependencies: payload.dependencies,
        sourcemap: payload.sourcemap,
      },
      update: {
        fileName: payload.fileName,
        bundle: payload.bundle,
        nodeVersion: payload.nodeVersion,
        dependencies: payload.dependencies,
        sourcemap: payload.sourcemap,
      },
    });
  }

  #hashPayload(payload: DeployBackgroundTaskRequestBody) {
    // Create a hash out of the bundle, the nodeVersion, and a determinstically list of dependencies
    // This will allow us to determine if the bundle has changed
    const hash = nodeCrypto.createHash("sha256");

    hash.update(payload.bundle);
    hash.update(payload.nodeVersion);

    const dependencies = Object.keys(payload.dependencies).sort();

    for (const dependency of dependencies) {
      hash.update(dependency);
      hash.update(payload.dependencies[dependency]);
    }

    return hash.digest("hex");
  }
}
