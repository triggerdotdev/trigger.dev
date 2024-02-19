import {
  SemanticInternalAttributes,
  TriggerTaskRequestBody,
  flattenAttributes,
} from "@trigger.dev/core/v3";
import { nanoid } from "nanoid";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { BaseService } from "./baseService.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
};

export class TriggerTaskService extends BaseService {
  public async call(
    taskId: string,
    environment: AuthenticatedEnvironment,
    body: TriggerTaskRequestBody,
    options: TriggerTaskServiceOptions = {}
  ) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const idempotencyKey = options.idempotencyKey ?? nanoid();

      const existingRun = await this._prisma.taskRun.findUnique({
        where: {
          runtimeEnvironmentId_idempotencyKey: {
            runtimeEnvironmentId: environment.id,
            idempotencyKey,
          },
        },
      });

      if (existingRun) {
        span.setAttribute("runId", existingRun.friendlyId);

        return existingRun;
      }

      return await eventRepository.traceEvent(
        `Triggering task ${taskId}`,
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
              icon: "play",
            },
          },
        },
        async (event, traceContext) => {
          const parentAttempt = body.options?.parentAttempt
            ? await this._prisma.taskRunAttempt.findUnique({
                where: {
                  friendlyId: body.options.parentAttempt,
                },
              })
            : undefined;

          const queueName = body.options?.queue?.name ?? `task/${taskId}`;

          event.setAttribute("queueName", queueName);
          span.setAttribute("queueName", queueName);

          const taskRun = await this._prisma.taskRun.create({
            data: {
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
              concurrencyKey: body.options?.concurrencyKey,
              queue: queueName,
            },
          });

          event.setAttribute("runId", taskRun.friendlyId);
          span.setAttribute("runId", taskRun.friendlyId);

          // We need to enqueue the task run into the appropriate queue
          await marqs?.enqueueMessage(
            environment,
            queueName,
            taskRun.id,
            { type: "EXECUTE", taskIdentifier: taskId },
            body.options?.concurrencyKey
          );

          return taskRun;
        }
      );
    });
  }
}
