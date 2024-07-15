import { type ServerTask , type RunTaskResponseWithCachedTasksBody } from '@trigger.dev/core/schemas';
import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { prepareTasksForCaching } from "~/models/task.server";

export class ChangeRequestLazyLoadedCachedTasks {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    runId: string,
    task: ServerTask,
    cursor?: string | null
  ): Promise<RunTaskResponseWithCachedTasksBody> {
    if (!cursor) {
      return {
        task,
      };
    }

    // We need to limit the cached tasks to not be too large >2MB when serialized
    const TOTAL_CACHED_TASK_BYTE_LIMIT = 2000000;

    const nextTasks = await this.#prismaClient.task.findMany({
      where: {
        runId,
        status: "COMPLETED",
        noop: false,
      },
      take: 250,
      cursor: {
        id: cursor,
      },
      orderBy: {
        id: "asc",
      },
    });

    const preparedTasks = prepareTasksForCaching(nextTasks, TOTAL_CACHED_TASK_BYTE_LIMIT);

    return {
      task,
      cachedTasks: preparedTasks,
    };
  }
}
