import { TriggerTaskRequestBody } from "@trigger.dev/core";
import { nanoid } from "nanoid";
import { PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generateFriendlyId } from "../friendlyIdentifiers";

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
        friendlyId: generateFriendlyId("run"),
        runtimeEnvironmentId: environment.id,
        projectId: environment.projectId,
        idempotencyKey,
        taskIdentifier: taskId,
        payload: JSON.stringify(body.payload),
        payloadType: "application/json",
        context: body.context,
      },
    });

    return taskRun;
  }
}
