import { createHash } from "node:crypto";
import { SemanticInternalAttributes, TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { flattenAttributes } from "@trigger.dev/core/v3";
import { nanoid } from "nanoid";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
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

    return await eventRepository.traceEvent(
      `${taskId}`,
      {
        context: options.traceContext,
        kind: "SERVER",
        environment,
        taskSlug: taskId,
        attributes: {
          metadata: {
            ...flattenAttributes(body.payload, SemanticInternalAttributes.PAYLOAD),
          },
          style: {
            icon: "task",
          },
        },
      },
      async (event, traceContext) => {
        const lockId = taskIdentifierToLockId(taskId);

        return await $transaction(this.#prismaClient, async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

          const parentAttempt = body.options?.parentAttempt
            ? await tx.taskRunAttempt.findUnique({
                where: {
                  friendlyId: body.options.parentAttempt,
                },
              })
            : undefined;

          const counter = await tx.taskRunCounter.upsert({
            where: { taskIdentifier: taskId },
            update: { lastNumber: { increment: 1 } },
            create: { taskIdentifier: taskId, lastNumber: 1 },
            select: { lastNumber: true },
          });

          const taskRun = await tx.taskRun.create({
            data: {
              number: counter.lastNumber,
              friendlyId: generateFriendlyId("run"),
              runtimeEnvironmentId: environment.id,
              projectId: environment.projectId,
              idempotencyKey,
              taskIdentifier: taskId,
              payload: JSON.stringify(body.payload),
              payloadType: "application/json",
              context: body.context,
              traceContext: traceContext,
              traceId: event.traceId,
              spanId: event.spanId,
              parentAttemptId: parentAttempt?.id,
              lockedToVersionId: body.options?.lockToCurrentVersion
                ? parentAttempt?.backgroundWorkerId
                : undefined,
            },
          });

          event.setAttribute("runId", taskRun.friendlyId);

          return taskRun;
        });
      }
    );
  }
}

function taskIdentifierToLockId(taskIdentifier: string): number {
  // Convert taskIdentifier to a unique lock identifier
  return parseInt(createHash("sha256").update(taskIdentifier).digest("hex").slice(0, 8), 16);
}
