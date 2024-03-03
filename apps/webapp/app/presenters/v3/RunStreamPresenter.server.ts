import { JobRun, TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { sse } from "~/utils/sse.server";

type RunWithAttempts = {
  updatedAt: Date;
  attempts: {
    status: TaskRunAttempt["status"];
    updatedAt: Date;
  }[];
};

export class RunStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    request,
    runFriendlyId,
  }: {
    request: Request;
    runFriendlyId: TaskRun["friendlyId"];
  }) {
    const run = await this.#runForUpdates(runFriendlyId);

    if (!run) {
      return new Response("Not found", { status: 404 });
    }

    let lastUpdatedAt = this.#getLatestUpdatedAt(run);

    logger.info("RunStreamPresenter.call", {
      runFriendlyId,
      lastUpdatedAt,
    });

    return sse({
      request,
      run: async (send, stop) => {
        const result = await this.#runForUpdates(runFriendlyId);
        if (!result) {
          return stop();
        }

        if (this.#isRunCompleted(result)) {
          logger.info("RunStreamPresenter.call completed", {
            runFriendlyId,
            lastUpdatedAt,
            completed: true,
          });
          send({ data: new Date().toISOString() });
          return stop();
        }

        const newUpdatedAt = this.#getLatestUpdatedAt(result);
        if (lastUpdatedAt !== newUpdatedAt) {
          logger.info("RunStreamPresenter.call updated", {
            runFriendlyId,
            lastUpdatedAt,
            newUpdatedAt,
          });
          send({ data: result.updatedAt.toISOString() });
        }

        logger.info("RunStreamPresenter.call waiting", {
          runFriendlyId,
          lastUpdatedAt,
          newUpdatedAt,
        });

        lastUpdatedAt = newUpdatedAt;
      },
    });
  }

  #runForUpdates(friendlyId: string) {
    return this.#prismaClient.taskRun.findUnique({
      where: {
        friendlyId,
      },
      select: {
        updatedAt: true,
        attempts: {
          select: {
            status: true,
            updatedAt: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
    });
  }

  #getLatestUpdatedAt(run: RunWithAttempts) {
    const lastAttempt = run.attempts[0];
    if (lastAttempt) {
      return lastAttempt.updatedAt.getTime();
    }

    return run.updatedAt.getTime();
  }

  #isRunCompleted(run: RunWithAttempts) {
    return run.attempts.some(
      (attempt) =>
        attempt.status === "FAILED" ||
        attempt.status === "CANCELED" ||
        attempt.status === "COMPLETED"
    );
  }
}
