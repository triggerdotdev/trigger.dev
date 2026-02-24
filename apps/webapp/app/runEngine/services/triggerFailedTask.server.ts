import { RunEngine } from "@internal/run-engine";
import { TaskRunErrorCodes, type TaskRunError } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { RuntimeEnvironmentType, TaskRun } from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { getEventRepository } from "~/v3/eventRepository/index.server";
import { DefaultQueueManager } from "../concerns/queues.server";
import type { TriggerTaskRequest } from "../types";

export type TriggerFailedTaskRequest = {
  /** The task identifier (e.g. "my-task") */
  taskId: string;
  /** The fully-resolved authenticated environment */
  environment: AuthenticatedEnvironment;
  /** Raw payload — string or object */
  payload: unknown;
  /** MIME type of the payload (defaults to "application/json") */
  payloadType?: string;
  /** Error message describing why the run failed */
  errorMessage: string;
  /** Parent run friendly ID (e.g. "run_xxxx") */
  parentRunId?: string;
  /** Whether completing this run should resume the parent */
  resumeParentOnCompletion?: boolean;
  /** Batch association */
  batch?: { id: string; index: number };
  /** Trigger options from the original request (queue config, etc.) */
  options?: Record<string, unknown>;
  /** Trace context for span correlation */
  traceContext?: Record<string, unknown>;
  /** Whether the span parent should be treated as a link rather than a parent */
  spanParentAsLink?: boolean;

  errorCode?: TaskRunErrorCodes;
};

/**
 * Creates a pre-failed TaskRun with a trace event span.
 *
 * This is used when a task cannot be triggered (e.g. queue limit reached, validation
 * error, etc.) but we still need to record the failure so that:
 * - Batch completion can track the item
 * - Parent runs get unblocked
 * - The failed run shows up in the run logs view
 *
 * This service resolves the parent run (for rootTaskRunId/depth) and queue properties
 * the same way triggerTask does, so the run is correctly associated in the task tree
 * and the SpanPresenter can find the TaskQueue.
 */
export class TriggerFailedTaskService {
  private readonly prisma: PrismaClientOrTransaction;
  private readonly engine: RunEngine;

  constructor(opts: { prisma: PrismaClientOrTransaction; engine: RunEngine }) {
    this.prisma = opts.prisma;
    this.engine = opts.engine;
  }

  async call(request: TriggerFailedTaskRequest): Promise<string | null> {
    const failedRunFriendlyId = RunId.generate().friendlyId;
    const taskRunError: TaskRunError = {
      type: "INTERNAL_ERROR" as const,
      code: request.errorCode ?? TaskRunErrorCodes.UNSPECIFIED_ERROR,
      message: request.errorMessage,
    };

    try {
      const { repository, store } = await getEventRepository(
        request.environment.organization.featureFlags as Record<string, unknown>,
        undefined
      );

      // Resolve parent run for rootTaskRunId and depth (same as triggerTask.server.ts)
      const parentRun = request.parentRunId
        ? await this.prisma.taskRun.findFirst({
          where: {
            id: RunId.fromFriendlyId(request.parentRunId),
            runtimeEnvironmentId: request.environment.id,
          },
        })
        : undefined;

      const depth = parentRun ? parentRun.depth + 1 : 0;
      const rootTaskRunId = parentRun?.rootTaskRunId ?? parentRun?.id;

      // Resolve queue properties (same as triggerTask) so span presenter can find TaskQueue.
      // Best-effort: if resolution throws (e.g. request shape, missing worker), we still create
      // the run without queue/lockedQueueId so run creation and trace events never regress.
      let queueName: string | undefined;
      let lockedQueueId: string | undefined;
      try {
        const queueConcern = new DefaultQueueManager(this.prisma, this.engine);
        const bodyOptions = request.options as TriggerTaskRequest["body"]["options"];
        const triggerRequest: TriggerTaskRequest = {
          taskId: request.taskId,
          friendlyId: failedRunFriendlyId,
          environment: request.environment,
          body: {
            payload:
              typeof request.payload === "string"
                ? request.payload
                : JSON.stringify(request.payload ?? {}),
            options: bodyOptions,
          },
        };

        // Resolve the locked background worker if lockToVersion is set (same as triggerTask).
        // resolveQueueProperties requires the worker to be passed when lockToVersion is present.
        const lockedToBackgroundWorker = bodyOptions?.lockToVersion
          ? await this.prisma.backgroundWorker.findFirst({
            where: {
              projectId: request.environment.projectId,
              runtimeEnvironmentId: request.environment.id,
              version: bodyOptions.lockToVersion,
            },
            select: {
              id: true,
              version: true,
              sdkVersion: true,
              cliVersion: true,
            },
          })
          : undefined;

        const resolved = await queueConcern.resolveQueueProperties(
          triggerRequest,
          lockedToBackgroundWorker ?? undefined
        );
        queueName = resolved.queueName;
        lockedQueueId = resolved.lockedQueueId;
      } catch (queueResolveError) {
        const err =
          queueResolveError instanceof Error
            ? queueResolveError
            : new Error(String(queueResolveError));
        logger.warn("TriggerFailedTaskService: queue resolution failed, using defaults", {
          taskId: request.taskId,
          friendlyId: failedRunFriendlyId,
          error: err.message,
        });
      }

      // Create the failed run inside a trace event span so it shows up in run logs
      const failedRun: TaskRun = await repository.traceEvent(
        request.taskId,
        {
          context: request.traceContext,
          spanParentAsLink: request.spanParentAsLink,
          kind: "SERVER",
          environment: {
            id: request.environment.id,
            type: request.environment.type,
            organizationId: request.environment.organizationId,
            projectId: request.environment.projectId,
            project: { externalRef: request.environment.project.externalRef },
          },
          taskSlug: request.taskId,
          attributes: {
            properties: {},
            style: { icon: "task" },
          },
          incomplete: false,
          isError: true,
          immediate: true,
        },
        async (event, traceContext) => {
          event.setAttribute("runId", failedRunFriendlyId);
          event.failWithError(taskRunError);

          return await this.engine.createFailedTaskRun({
            friendlyId: failedRunFriendlyId,
            environment: {
              id: request.environment.id,
              type: request.environment.type,
              project: { id: request.environment.project.id },
              organization: { id: request.environment.organization.id },
            },
            taskIdentifier: request.taskId,
            payload:
              typeof request.payload === "string"
                ? request.payload
                : JSON.stringify(request.payload ?? ""),
            payloadType: request.payloadType ?? "application/json",
            error: taskRunError,
            parentTaskRunId: parentRun?.id,
            rootTaskRunId,
            depth,
            resumeParentOnCompletion: request.resumeParentOnCompletion,
            batch: request.batch,
            traceId: event.traceId,
            spanId: event.spanId,
            traceContext: traceContext as Record<string, unknown>,
            taskEventStore: store,
            ...(queueName !== undefined && { queue: queueName }),
            ...(lockedQueueId !== undefined && { lockedQueueId }),
          });
        }
      );

      return failedRun.friendlyId;
    } catch (createError) {
      const createErrorMsg =
        createError instanceof Error ? createError.message : String(createError);
      logger.error("TriggerFailedTaskService: failed to create pre-failed TaskRun", {
        taskId: request.taskId,
        friendlyId: failedRunFriendlyId,
        originalError: request.errorMessage,
        createError: createErrorMsg,
      });
      return null;
    }
  }

  /**
   * Creates a pre-failed run without trace events.
   * Used when the environment can't be fully resolved (e.g. environment not found)
   * and we can't create trace events or look up parent runs.
   */
  async callWithoutTraceEvents(opts: {
    environmentId: string;
    environmentType: RuntimeEnvironmentType;
    projectId: string;
    organizationId: string;
    taskId: string;
    payload: unknown;
    payloadType?: string;
    errorMessage: string;
    parentRunId?: string;
    resumeParentOnCompletion?: boolean;
    batch?: { id: string; index: number };
    errorCode?: TaskRunErrorCodes;
  }): Promise<string | null> {
    const failedRunFriendlyId = RunId.generate().friendlyId;

    try {
      // Best-effort parent run lookup for rootTaskRunId/depth
      let parentTaskRunId: string | undefined;
      let rootTaskRunId: string | undefined;
      let depth = 0;

      if (opts.parentRunId) {
        const parentRun = await this.prisma.taskRun.findFirst({
          where: {
            id: RunId.fromFriendlyId(opts.parentRunId),
            runtimeEnvironmentId: opts.environmentId,
          },
        });

        if (parentRun) {
          parentTaskRunId = parentRun.id;
          rootTaskRunId = parentRun.rootTaskRunId ?? parentRun.id;
          depth = parentRun.depth + 1;
        } else {
          parentTaskRunId = RunId.fromFriendlyId(opts.parentRunId);
        }
      }

      await this.engine.createFailedTaskRun({
        friendlyId: failedRunFriendlyId,
        environment: {
          id: opts.environmentId,
          type: opts.environmentType,
          project: { id: opts.projectId },
          organization: { id: opts.organizationId },
        },
        taskIdentifier: opts.taskId,
        payload:
          typeof opts.payload === "string"
            ? opts.payload
            : JSON.stringify(opts.payload ?? ""),
        payloadType: opts.payloadType ?? "application/json",
        error: {
          type: "INTERNAL_ERROR" as const,
          code: opts.errorCode ?? TaskRunErrorCodes.UNSPECIFIED_ERROR,
          message: opts.errorMessage,
        },
        parentTaskRunId,
        rootTaskRunId,
        depth,
        resumeParentOnCompletion: opts.resumeParentOnCompletion,
        batch: opts.batch,
      });

      return failedRunFriendlyId;
    } catch (createError) {
      logger.error("TriggerFailedTaskService: failed to create pre-failed TaskRun (no trace)", {
        taskId: opts.taskId,
        friendlyId: failedRunFriendlyId,
        originalError: opts.errorMessage,
        createError: createError instanceof Error ? createError.message : String(createError),
      });
      return null;
    }
  }
}
