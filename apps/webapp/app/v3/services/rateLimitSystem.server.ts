import { PrismaClient, Prisma } from "@trigger.dev/database";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { removeQueueRateLimits, updateQueueRateLimits } from "../runQueue.server";

export class RateLimitSystem {
  constructor(
    private prisma: PrismaClient
  ) {}

  async overrideQueueRateLimit(
    environment: AuthenticatedEnvironment,
    queueName: string,
    rateLimits: Array<{ limit: number; window: number }>
  ) {
    const queue = await this.prisma.taskQueue.updateMany({
      where: {
        runtimeEnvironmentId: environment.id,
        name: queueName,
      },
      data: {
        rateLimit: rateLimits,
      },
    });

    await updateQueueRateLimits(environment, queueName, rateLimits);
  }

  async resetQueueRateLimit(environment: AuthenticatedEnvironment, queueName: string) {
    await this.prisma.taskQueue.updateMany({
      where: {
        runtimeEnvironmentId: environment.id,
        name: queueName,
      },
      data: {
        rateLimit: Prisma.DbNull,
      },
    });

    await removeQueueRateLimits(environment, queueName);
  }
}
