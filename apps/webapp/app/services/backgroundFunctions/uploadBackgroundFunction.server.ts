import { UploadBackgroundFunctionRequestBody } from "@trigger.dev/core";
import { PrismaClient } from "@trigger.dev/database";
import nodeCrypto from "node:crypto";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";

export class UploadBackgroundFunctionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    payload: UploadBackgroundFunctionRequestBody
  ) {
    const hash = this.#hashPayload(payload);

    const backgroundFunction = await this.#prismaClient.backgroundFunction.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: payload.id,
        },
      },
    });

    if (!backgroundFunction) {
      return;
    }

    const artifact = await this.#prismaClient.backgroundFunctionArtifact.upsert({
      where: {
        backgroundFunctionId_version_hash: {
          backgroundFunctionId: backgroundFunction.id,
          version: payload.version,
          hash,
        },
      },
      create: {
        backgroundFunctionId: backgroundFunction.id,
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

    return artifact;
  }

  #hashPayload(payload: UploadBackgroundFunctionRequestBody) {
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
