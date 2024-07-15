import { type Job } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";

type ApiRunOptions = {
  runId: Job["id"];
  maxTasks?: number;
  taskDetails?: boolean;
  subTasks?: boolean;
  cursor?: string;
};

export class ApiRunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    runId,
    maxTasks = 20,
    taskDetails = false,
    subTasks = false,
    cursor,
  }: ApiRunOptions) {
    const take = Math.min(maxTasks, 50);

    return await prisma.jobRun.findUnique({
      where: {
        id: runId,
      },
      select: {
        id: true,
        status: true,
        startedAt: true,
        updatedAt: true,
        completedAt: true,
        environmentId: true,
        output: true,
        tasks: {
          select: {
            id: true,
            parentId: true,
            displayKey: true,
            status: true,
            name: true,
            icon: true,
            startedAt: true,
            completedAt: true,
            params: taskDetails,
            output: taskDetails,
          },
          where: {
            parentId: subTasks ? undefined : null,
          },
          orderBy: {
            id: "asc",
          },
          take: take + 1,
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
        },
        statuses: {
          select: { key: true, label: true, state: true, data: true, history: true },
        },
      },
    });
  }
}
