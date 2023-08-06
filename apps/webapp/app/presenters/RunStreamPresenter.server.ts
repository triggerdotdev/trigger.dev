import { JobRun } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { sse } from "~/utils/sse";

export class RunStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ request, runId }: { request: Request; runId: JobRun["id"] }) {
    const run = await this.#runForUpdates(runId);

    if (!run) {
      return new Response("Not found", { status: 404 });
    }

    let lastUpdatedAt: number = run.updatedAt.getTime();
    let lastTotalTaskUpdatedTime = run.tasks.reduce(
      (prev, task) => prev + task.updatedAt.getTime(),
      0
    );

    return sse({
      request,
      run: async (send, stop) => {
        const result = await this.#runForUpdates(runId);
        if (!result) {
          return stop();
        }

        if (result.completedAt) {
          send({ data: new Date().toISOString() });
          return stop();
        }

        const totalRunUpdated = result.tasks.reduce(
          (prev, task) => prev + task.updatedAt.getTime(),
          0
        );

        if (lastUpdatedAt !== result.updatedAt.getTime()) {
          send({ data: result.updatedAt.toISOString() });
        } else if (lastTotalTaskUpdatedTime !== totalRunUpdated) {
          send({ data: new Date().toISOString() });
        }

        lastUpdatedAt = result.updatedAt.getTime();
        lastTotalTaskUpdatedTime = totalRunUpdated;
      },
    });
  }

  #runForUpdates(id: string) {
    return this.#prismaClient.jobRun.findUnique({
      where: {
        id,
      },
      select: {
        updatedAt: true,
        completedAt: true,
        tasks: {
          select: {
            updatedAt: true,
          },
        },
      },
    });
  }
}
