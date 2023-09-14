import { DeployBackgroundTaskRequestBody } from "@trigger.dev/core";
import { PrismaClient } from "@trigger.dev/database";
import nodeCrypto from "node:crypto";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { backgroundTaskProvider } from "./provider.server";

export class DeployBackgroundTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    payload: DeployBackgroundTaskRequestBody
  ) {
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

    const artifact = await this.#prismaClient.backgroundTaskArtifact.upsert({
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

    const imageConfig = await backgroundTaskProvider.prepareArtifact(backgroundTask, artifact);

    return {
      artifact,
      imageConfig,
    };
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
