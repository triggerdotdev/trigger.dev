import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { CallbackTaskBodyOutput } from "@trigger.dev/core";
import { CallbackTaskBodyInputSchema } from "@trigger.dev/core";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import { $transaction, PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { enqueueRunExecutionV2 } from "~/models/jobRunExecution.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  runId: z.string(),
  id: z.string(),
  secret: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const { runId, id } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  // Allows any valid object
  // TODO: maybe add proper schema parsing during io.runTask(), or even skip this step
  const body = CallbackTaskBodyInputSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CallbackRunTaskService();

  try {
    await service.call(runId, id, body.data, new URL(request.url).href);

    return json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error while processing task callback:", { error });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

export class CallbackRunTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    runId: string,
    id: string,
    taskBody: CallbackTaskBodyOutput,
    callbackUrl: string
  ): Promise<void> {
    const task = await findTask(prisma, id);

    if (!task) {
      return;
    }

    if (task.runId !== runId) {
      return;
    }

    if (task.status !== "WAITING") {
      return;
    }

    if (!task.callbackUrl) {
      return;
    }

    if (new URL(task.callbackUrl).pathname !== new URL(callbackUrl).pathname) {
      logger.error("Callback URLs don't match", { runId, taskId: id, callbackUrl });
      return;
    }

    logger.debug("CallbackRunTaskService.call()", { task });

    await this.#resumeTask(task, taskBody);
  }

  async #resumeTask(task: NonNullable<FoundTask>, output: Record<string, any>) {
    await $transaction(this.#prismaClient, async (tx) => {
      await tx.taskAttempt.updateMany({
        where: {
          taskId: task.id,
          status: "PENDING",
        },
        data: {
          status: "COMPLETED",
        },
      });

      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: output ? output : undefined,
        },
      });

      await this.#resumeRunExecution(task, tx);
    });
  }

  async #resumeRunExecution(task: NonNullable<FoundTask>, prisma: PrismaClientOrTransaction) {
    await enqueueRunExecutionV2(task.run, prisma, {
      skipRetrying: task.run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
    });
  }
}

type FoundTask = Awaited<ReturnType<typeof findTask>>;

async function findTask(prisma: PrismaClientOrTransaction, id: string) {
  return prisma.task.findUnique({
    where: { id },
    include: {
      run: {
        include: {
          environment: true,
          queue: true,
        },
      },
    },
  });
}
