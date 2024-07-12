import { type PrismaClient, prisma } from "~/db.server";
import { PerformRunExecutionV3Service } from "./performRunExecutionV3.server";
import { ResumeRunService } from "./resumeRun.server";

export class CancelRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {
    try {
      return await this.#prismaClient.$transaction(async (tx) => {
        const run = await tx.jobRun.findUniqueOrThrow({
          where: {
            id: runId,
          },
        });

        await tx.jobRun.update({
          where: { id: runId },
          data: {
            status: "CANCELED",
            completedAt: new Date(),
          },
        });

        await tx.task.updateMany({
          where: {
            runId,
            status: {
              in: ["PENDING", "RUNNING", "WAITING"],
            },
          },
          data: {
            status: "CANCELED",
            completedAt: new Date(),
          },
        });

        await PerformRunExecutionV3Service.dequeue(run, tx);
        await ResumeRunService.dequeue(run, tx);
      });
    } catch (error) {
      throw error;
    }
  }
}
