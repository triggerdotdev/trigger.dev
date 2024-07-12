import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "../logger.server";

class ForceYieldCoordinator {
  private inFlightRuns: Set<string> = new Set();
  private prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient) {
    this.prismaClient = prismaClient;

    process.on("SIGTERM", this.handleForceYield);
  }

  // Add a run to the in-flight set
  public registerRun(runId: string): void {
    this.inFlightRuns.add(runId);
  }

  // Remove a run from the in-flight set
  public deregisterRun(runId: string): void {
    this.inFlightRuns.delete(runId);
  }

  // Handle forced yield on SIGTERM
  private handleForceYield = async (): Promise<void> => {
    const runIds = Array.from(this.inFlightRuns);

    const results = await this.prismaClient.jobRun.updateMany({
      where: {
        id: {
          in: runIds,
        },
        forceYieldImmediately: false,
      },
      data: {
        forceYieldImmediately: true,
      },
    });

    logger.debug(
      `ForceYieldCoordinator: ${results.count}/${runIds.length} runs set to immediately force yield`
    );
  };
}

export const forceYieldCoordinator = new ForceYieldCoordinator(prisma);
