import type { RunEngine } from "@internal/run-engine";
import { TaskRunErrorCodes, type TaskRunError } from "@trigger.dev/core/v3";
import { RunId, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type {
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRun,
} from "@trigger.dev/database";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { resolveRunIdMintKind } from "~/v3/engineVersion.server";
import { resolveInheritedMintKind } from "~/v3/runOpsMigration/resolveInheritedMintKind.server";
import { getEventRepository } from "~/v3/eventRepository/index.server";
import { runStore as defaultRunStore } from "~/v3/runStore.server";
import type { RunStore } from "@internal/run-store";
import type { IEventRepository } from "~/v3/eventRepository/eventRepository.types";
import { PerformTaskRunAlertsService } from "~/v3/services/alerts/performTaskRunAlerts.server";
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

  /** Pre-minted friendlyId; when set it wins over the mint. Batch callers pass a batch-anchored id. */
  runFriendlyId?: string;
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
  private readonly replicaPrisma: PrismaClientOrTransaction;
  private readonly engine: RunEngine;
  // Resolves the parent run for depth/root/parent linkage. Defaults to the shared
  // singleton (in production the same store the engine writes through). Injected in
  // tests so the read resolves on the same store the engine wrote to.
  private readonly runStore: RunStore;
  // Defaults to getEventRepository's org-flag resolution, which reads through the
  // global prisma client; tests inject a repository bound to their testcontainer DB.
  private readonly eventRepository?: { repository: IEventRepository; store: string };

  constructor(opts: {
    prisma: PrismaClientOrTransaction;
    engine: RunEngine;
    replicaPrisma?: PrismaClientOrTransaction;
    runStore?: RunStore;
    eventRepository?: { repository: IEventRepository; store: string };
  }) {
    this.prisma = opts.prisma;
    this.replicaPrisma = opts.replicaPrisma ?? opts.prisma;
    this.engine = opts.engine;
    this.runStore = opts.runStore ?? defaultRunStore;
    this.eventRepository = opts.eventRepository;
  }

  // Mint a failed run's friendlyId. The id-kind decides which store the run is
  // born in (cuid → legacy store, run-ops id → new store); the whole subgraph of a
  // run must agree. A caller-supplied runFriendlyId (batch-anchored id) wins verbatim;
  // otherwise root failed runs mint by the environment's setting and child failed runs
  // inherit the parent's current store so they never split.
  private async mintFailedRunFriendlyId(args: {
    organizationId: string;
    environmentId: string;
    orgFeatureFlags?: unknown;
    parentRunFriendlyId?: string;
    runFriendlyId?: string;
  }): Promise<string> {
    if (args.runFriendlyId) {
      return args.runFriendlyId;
    }

    const mintKind = args.parentRunFriendlyId
      ? resolveInheritedMintKind(args.parentRunFriendlyId)
      : await resolveRunIdMintKind({
          organizationId: args.organizationId,
          id: args.environmentId,
          orgFeatureFlags: args.orgFeatureFlags,
        });

    return mintKind === "runOpsId"
      ? RunId.toFriendlyId(generateRunOpsId())
      : RunId.generate().friendlyId;
  }

  async call(request: TriggerFailedTaskRequest): Promise<string | null> {
    const taskRunError: TaskRunError = {
      type: "INTERNAL_ERROR" as const,
      code: request.errorCode ?? TaskRunErrorCodes.UNSPECIFIED_ERROR,
      message: request.errorMessage,
    };

    // Held for the catch's log line; the in-try `const` is what consumers use.
    let mintedFriendlyId: string | undefined;

    try {
      // Mint inside the try: classifying a user-supplied parentRunId throws on
      // an unclassifiable id, so keep it within the catch's null-return contract.
      const failedRunFriendlyId = await this.mintFailedRunFriendlyId({
        organizationId: request.environment.organizationId,
        environmentId: request.environment.id,
        orgFeatureFlags: request.environment.organization.featureFlags,
        parentRunFriendlyId: request.parentRunId,
        runFriendlyId: request.runFriendlyId,
      });
      mintedFriendlyId = failedRunFriendlyId;

      const { repository, store } =
        this.eventRepository ??
        (await getEventRepository(
          request.environment.organization.id,
          request.environment.organization.featureFlags as Record<string, unknown>,
          undefined
        ));

      // Resolve parent run for rootTaskRunId and depth (same as triggerTask.server.ts)
      const parentRun = request.parentRunId
        ? await this.runStore.findRun(
            {
              id: RunId.fromFriendlyId(request.parentRunId),
              runtimeEnvironmentId: request.environment.id,
            },
            this.prisma
          )
        : undefined;

      const depth = parentRun ? parentRun.depth + 1 : 0;
      const rootTaskRunId = parentRun?.rootTaskRunId ?? parentRun?.id;

      // Resolve queue properties (same as triggerTask) so span presenter can find TaskQueue.
      // Best-effort: if resolution throws (e.g. request shape, missing worker), we still create
      // the run without queue/lockedQueueId so run creation and trace events never regress.
      let queueName: string | undefined;
      let lockedQueueId: string | undefined;
      try {
        const queueConcern = new DefaultQueueManager(this.prisma, this.engine, this.replicaPrisma);
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

          // `emitRunFailedEvent: false` because this call site owns the
          // trace-event lifecycle via the outer `traceEvent({
          // incomplete: false, isError: true })`. Letting the engine
          // emit `runFailed` here would race the
          // `completeFailedRunEvent` listener against the outer trace
          // event's own completion write for the same (traceId, spanId).
          // We re-trigger the alerts side directly after the trace
          // event closes, below.
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
            emitRunFailedEvent: false,
            ...(queueName !== undefined && { queue: queueName }),
            ...(lockedQueueId !== undefined && { lockedQueueId }),
          });
        }
      );

      // Alerts side of `runFailed` — the engine emit was suppressed
      // above so the trace-event completion isn't double-written; we
      // still need the alert pipeline to fire so customers' ERROR
      // channels see the failure. Best-effort: a failed enqueue logs
      // but doesn't block returning the friendlyId, mirroring the
      // engine handler's behaviour at runEngineHandlers.server.ts:81.
      try {
        await PerformTaskRunAlertsService.enqueue(failedRun.id);
      } catch (alertsError) {
        logger.warn("TriggerFailedTaskService: alert enqueue failed", {
          taskId: request.taskId,
          friendlyId: failedRun.friendlyId,
          error: alertsError instanceof Error ? alertsError.message : String(alertsError),
        });
      }

      return failedRun.friendlyId;
    } catch (createError) {
      const createErrorMsg =
        createError instanceof Error ? createError.message : String(createError);
      logger.error("TriggerFailedTaskService: failed to create pre-failed TaskRun", {
        taskId: request.taskId,
        friendlyId: mintedFriendlyId,
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
    /** Pre-minted friendlyId; when set it wins over the mint. Batch callers pass a batch-anchored id. */
    runFriendlyId?: string;
  }): Promise<string | null> {
    // Held for the catch's log line; the in-try `const` is what consumers use.
    let mintedFriendlyId: string | undefined;

    try {
      // Mint inside the try: classifying a user-supplied parentRunId throws on
      // an unclassifiable id, so keep it within the catch's null-return contract.
      const failedRunFriendlyId = await this.mintFailedRunFriendlyId({
        organizationId: opts.organizationId,
        environmentId: opts.environmentId,
        // No loaded org flags in this path; resolveRunIdMintKind falls back to a
        // single replica lookup by organizationId only when there is no parent.
        orgFeatureFlags: undefined,
        parentRunFriendlyId: opts.parentRunId,
        runFriendlyId: opts.runFriendlyId,
      });
      mintedFriendlyId = failedRunFriendlyId;

      // Best-effort parent run lookup for rootTaskRunId/depth
      let parentTaskRunId: string | undefined;
      let rootTaskRunId: string | undefined;
      let depth = 0;

      if (opts.parentRunId) {
        const parentRun = await this.runStore.findRun(
          {
            id: RunId.fromFriendlyId(opts.parentRunId),
            runtimeEnvironmentId: opts.environmentId,
          },
          this.prisma
        );

        if (parentRun) {
          parentTaskRunId = parentRun.id;
          rootTaskRunId = parentRun.rootTaskRunId ?? parentRun.id;
          depth = parentRun.depth + 1;
        } else {
          parentTaskRunId = RunId.fromFriendlyId(opts.parentRunId);
        }
      }

      const failedRun = await this.engine.createFailedTaskRun({
        friendlyId: failedRunFriendlyId,
        environment: {
          id: opts.environmentId,
          type: opts.environmentType,
          project: { id: opts.projectId },
          organization: { id: opts.organizationId },
        },
        taskIdentifier: opts.taskId,
        payload:
          typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload ?? ""),
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
        // Suppress the engine's `runFailed` bus emit — the listener
        // (`runEngineHandlers.server.ts` `runFailed`) calls
        // `completeFailedRunEvent`, which writes a ClickHouse trace event
        // row keyed on (traceId, spanId). This caller has no trace
        // context (the method name is literally `callWithoutTraceEvents`)
        // so the emit would write a row with empty traceId/spanId —
        // orphan event in the store. We still want alert coverage,
        // though, so enqueue directly below.
        emitRunFailedEvent: false,
      });

      // Alerts side of `runFailed` — the engine emit was suppressed
      // above so we don't create an orphan trace event; enqueue the
      // alert directly so customers' ERROR channels still see the
      // failure. Best-effort, mirroring the `call()` path.
      try {
        await PerformTaskRunAlertsService.enqueue(failedRun.id);
      } catch (alertsError) {
        logger.warn("TriggerFailedTaskService.callWithoutTraceEvents: alert enqueue failed", {
          taskId: opts.taskId,
          friendlyId: failedRun.friendlyId,
          error: alertsError instanceof Error ? alertsError.message : String(alertsError),
        });
      }

      return failedRunFriendlyId;
    } catch (createError) {
      logger.error("TriggerFailedTaskService: failed to create pre-failed TaskRun (no trace)", {
        taskId: opts.taskId,
        friendlyId: mintedFriendlyId,
        originalError: opts.errorMessage,
        createError: createError instanceof Error ? createError.message : String(createError),
      });
      return null;
    }
  }
}
