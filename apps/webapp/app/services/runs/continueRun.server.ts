import { Prisma, type PrismaClient, prisma } from "~/db.server";
import { ResumeRunService } from "./resumeRun.server";

const RESUMABLE_STATUSES = [
  "FAILURE",
  "TIMED_OUT",
  "UNRESOLVED_AUTH",
  "ABORTED",
  "CANCELED",
  "INVALID_PAYLOAD",
];

export class ContinueRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {
    const run = await this.#prismaClient.jobRun.findUniqueOrThrow({
      where: { id: runId },
      include: {
        environment: true,
      },
    });

    if (!RESUMABLE_STATUSES.includes(run.status)) {
      throw new Error("Run is not resumable");
    }

    await this.#prismaClient.jobRun.update({
      where: { id: runId },
      data: {
        status: "QUEUED",
        queuedAt: new Date(),
        startedAt: null,
        completedAt: null,
        output: Prisma.DbNull,
        timedOutAt: null,
        timedOutReason: null,
      },
    });

    // Now we need to reset errored tasks to PENDING
    await this.#prismaClient.task.updateMany({
      where: {
        runId: runId,
        status: "ERRORED",
      },
      data: {
        status: "RUNNING",
        output: Prisma.DbNull,
        completedAt: null,
        startedAt: new Date(),
      },
    });

    await ResumeRunService.enqueue(run, this.#prismaClient);
  }
}
