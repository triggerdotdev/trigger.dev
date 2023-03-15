import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { projectLogger } from "~/services/logger";
import { StartDeployment } from "./startDeployment.server";

const PayloadSchema = z.object({
  buildId: z.string(),
  imageId: z.string(),
});

export class BuildComplete {
  #prismaClient: PrismaClient;
  #startDeployment = new StartDeployment();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public validate(payload: unknown) {
    return PayloadSchema.safeParse(payload);
  }

  public async call(payload: z.infer<typeof PayloadSchema>) {
    console.log(`Build complete: ${payload.buildId} -> ${payload.imageId}`);

    const deployment = await this.#updateDeployment(
      payload.buildId,
      payload.imageId
    );

    if (!deployment) {
      return true;
    }

    projectLogger.debug("Deployment build complete", { deployment });

    // Only continue if this deployment is building or pending
    if (deployment.status !== "BUILDING") {
      return true;
    }

    return this.#startDeployment.call({
      deployment,
      project: deployment.project,
      environment: deployment.environment,
    });
  }

  async #updateDeployment(buildId: string, imageId: string) {
    try {
      return await this.#prismaClient.projectDeployment.update({
        where: {
          buildId,
        },
        data: {
          imageId,
        },
        include: {
          environment: true,
          project: {
            include: {
              currentDeployment: true,
            },
          },
        },
      });
    } catch (error) {
      return;
    }
  }
}
