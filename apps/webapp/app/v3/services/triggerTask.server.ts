import { TriggerTaskRequestBody } from "@trigger.dev/core";
import { nanoid } from "nanoid";
import { PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
};

export class TriggerTaskService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    runId: string,
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    const idempotencyKey = options.idempotencyKey ?? nanoid();

    const existingRun = await this.#prismaClient.taskRun.findUnique({
      where: {
        runtimeEnvironmentId_idempotencyKey: {
          runtimeEnvironmentId: environment.id,
          idempotencyKey,
        },
      },
    });

    if (existingRun) {
      return existingRun;
    }

    const taskRun = await this.#prismaClient.taskRun.create({
      data: {
        runtimeEnvironmentId: environment.id,
        projectId: environment.projectId,
        externalRef: runId,
        idempotencyKey,
        taskIdentifier: taskId,
        payload: JSON.stringify(body.payload),
        payloadType: "application/json",
        context: body.context,
        status: "PENDING",
      },
    });

    return taskRun;
  }
}
