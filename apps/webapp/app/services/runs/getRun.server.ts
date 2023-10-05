import { PrismaClient, prisma } from "~/db.server";
import { z } from "zod";

const GetRunInputSchema = z.object({
  runId: z.string(),
  maxTasks: z.number().default(20),
  taskDetails: z.boolean().default(false),
  subTasks: z.boolean().default(false),
  cursor: z.string().optional(),
});

export type GetRunInput = z.infer<typeof GetRunInputSchema>;

export class GetRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(input: GetRunInput) {
    const parsedInput = GetRunInputSchema.parse(input);

    const take = Math.min(parsedInput.maxTasks, 50);

    return await prisma.jobRun.findUnique({
      where: {
        id: input.runId,
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
            params: parsedInput.taskDetails,
            output: parsedInput.taskDetails,
          },
          where: {
            parentId: parsedInput.subTasks ? undefined : null,
          },
          orderBy: {
            id: "asc",
          },
          take: take + 1,
          cursor: parsedInput.cursor
            ? {
                id: parsedInput.cursor,
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
