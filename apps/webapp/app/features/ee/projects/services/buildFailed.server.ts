import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { projectLogger } from "~/services/logger";

const PayloadSchema = z.object({
  buildId: z.string(),
});

export class BuildFailed {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public validate(payload: unknown) {
    return PayloadSchema.safeParse(payload);
  }

  public async call(payload: z.infer<typeof PayloadSchema>) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        buildId: payload.buildId,
      },
    });

    if (!deployment) {
      return true;
    }

    projectLogger.debug("Build failed", { deployment });

    await this.#prismaClient.projectDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "ERROR",
      },
    });

    const project = await this.#prismaClient.repositoryProject.findUnique({
      where: {
        id: deployment.projectId,
      },
    });

    if (!project || project.status !== "BUILDING") {
      return true;
    }

    await this.#prismaClient.repositoryProject.update({
      where: {
        id: project.id,
      },
      data: {
        status: "ERROR",
      },
    });
  }
}
