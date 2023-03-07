import { z } from "zod";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

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
    console.log(`Build failed: ${payload.buildId}`);

    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        buildId: payload.buildId,
      },
    });

    if (!deployment) {
      return true;
    }

    await this.#prismaClient.projectDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "ERROR",
      },
    });
  }
}
