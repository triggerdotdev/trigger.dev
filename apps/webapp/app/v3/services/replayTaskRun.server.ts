import {
  type MachinePresetName,
  conditionallyImportPacket,
  parsePacket,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { EngineServiceValidationError } from "@internal/run-engine";
import { type TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { baseWorkerQueue } from "~/runEngine/concerns/workerQueueSplit.server";
import { logger } from "~/services/logger.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { type RunOptionsData } from "../testTask";
import { replaceSuperJsonPayload } from "@trigger.dev/core/v3/utils/ioSerialization";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";

type OverrideOptions = {
  environmentId?: string;
  payload?: string;
  /**
   * The encoding of `payload`, used as-is for the new run. Without it, an override of a
   * SuperJSON payload is plain JSON that keeps the original payload's type annotations,
   * which is what the dashboard's payload editor relies on.
   */
  payloadType?: "application/json" | "application/super+json";
  metadata?: unknown;
  bulkActionId?: string;
  triggerSource?: string;
  delay?: string | Date;
  ttl?: string | number;
  idempotencyKeyTTL?: string;
  // zod v4 types `.optional().transform()` fields as required-with-undefined in the
  // output; Partial keeps them omittable for callers passing a subset of overrides.
} & Partial<RunOptionsData>;

export class ReplayTaskRunService extends BaseService {
  public async call(existingTaskRun: TaskRun, overrideOptions: OverrideOptions = {}) {
    // An override environment must belong to the same project as the source
    // run. The source project is derived from the run's own environment rather
    // than existingTaskRun.projectId, since the buffered-run fallback passes a
    // synthetic TaskRun with no projectId. Only check when a distinct override
    // is supplied; otherwise the run's own environment is used.
    if (
      overrideOptions.environmentId &&
      overrideOptions.environmentId !== existingTaskRun.runtimeEnvironmentId
    ) {
      const [overrideEnvironment, sourceEnvironment] = await Promise.all([
        this._prisma.runtimeEnvironment.findFirst({
          where: { id: overrideOptions.environmentId },
          select: { projectId: true },
        }),
        this._prisma.runtimeEnvironment.findFirst({
          where: { id: existingTaskRun.runtimeEnvironmentId },
          select: { projectId: true },
        }),
      ]);
      if (
        !overrideEnvironment ||
        !sourceEnvironment ||
        overrideEnvironment.projectId !== sourceEnvironment.projectId
      ) {
        logger.warn("Refusing to replay a run into an environment outside its project", {
          taskRunId: existingTaskRun.id,
          taskRunFriendlyId: existingTaskRun.friendlyId,
          sourceEnvironmentId: existingTaskRun.runtimeEnvironmentId,
          sourceProjectId: sourceEnvironment?.projectId ?? null,
          overrideEnvironmentId: overrideOptions.environmentId,
          overrideProjectId: overrideEnvironment?.projectId ?? null,
        });
        throw new Error("Cannot replay a run into an environment outside its project");
      }
    }

    const authenticatedEnvironment = await findEnvironmentById(
      overrideOptions.environmentId ?? existingTaskRun.runtimeEnvironmentId
    );
    if (!authenticatedEnvironment) {
      return;
    }

    if (authenticatedEnvironment.archivedAt) {
      throw new Error("Can't replay a run on an archived environment");
    }

    logger.info("Replaying task run", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
    });

    const existingEnvironment = await this._prisma.runtimeEnvironment.findFirstOrThrow({
      where: {
        id: existingTaskRun.runtimeEnvironmentId,
      },
      select: {
        id: true,
        type: true,
      },
    });

    const payloadPacket = await this.overrideExistingPayloadPacket(
      existingTaskRun,
      overrideOptions.payload,
      overrideOptions.payloadType
    );
    const parsedPayload =
      payloadPacket.dataType === "application/json"
        ? await parsePacket(payloadPacket)
        : payloadPacket.data;
    const payloadType = payloadPacket.dataType;
    const metadata = overrideOptions.metadata ?? (await this.getExistingMetadata(existingTaskRun));
    const tags = overrideOptions.tags ?? existingTaskRun.runTags;
    // Only use the region from the existing run if V2 engine and neither environment is dev
    const ignoreRegion =
      existingTaskRun.engine === "V1" ||
      existingEnvironment.type === "DEVELOPMENT" ||
      authenticatedEnvironment.type === "DEVELOPMENT";
    const region = ignoreRegion
      ? undefined
      : overrideOptions.region ||
        existingTaskRun.region ||
        baseWorkerQueue(existingTaskRun.workerQueue);

    try {
      const taskQueue = await this._prisma.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: authenticatedEnvironment.id,
          name: overrideOptions.queue ?? existingTaskRun.queue,
        },
      });

      if (overrideOptions.queue && !taskQueue) {
        throw new ServiceValidationError(
          `Queue "${overrideOptions.queue}" was not found in this environment`
        );
      }

      const triggerTaskService = new TriggerTaskService();
      const result = await triggerTaskService.call(
        existingTaskRun.taskIdentifier,
        authenticatedEnvironment,
        {
          payload: parsedPayload,
          options: {
            payloadType,
            queue: taskQueue
              ? {
                  name: taskQueue.name,
                }
              : undefined,
            test: existingTaskRun.isTest,
            tags,
            metadata: metadata,
            delay:
              overrideOptions.delay ??
              (overrideOptions.delaySeconds
                ? new Date(Date.now() + overrideOptions.delaySeconds * 1000)
                : undefined),
            ttl: overrideOptions.ttl ?? overrideOptions.ttlSeconds,
            idempotencyKey: overrideOptions.idempotencyKey,
            idempotencyKeyTTL:
              overrideOptions.idempotencyKeyTTL ??
              (overrideOptions.idempotencyKeyTTLSeconds
                ? `${overrideOptions.idempotencyKeyTTLSeconds}s`
                : undefined),
            concurrencyKey:
              overrideOptions.concurrencyKey ?? existingTaskRun.concurrencyKey ?? undefined,
            /**
             * A run that held gates replays with those same gates. A run with none
             * stored passes undefined (never a fabricated empty array, which reads
             * as "clear the named limits") so the replay honors whatever limits the
             * task declares now, like it honors the current queue and retry config.
             */
            gates: Array.isArray(existingTaskRun.gates)
              ? (existingTaskRun.gates as Array<{ queue: string; concurrencyKey?: string }>)
              : undefined,
            maxAttempts: overrideOptions.maxAttempts,
            maxDuration: overrideOptions.maxDurationSeconds,
            machine:
              overrideOptions.machine ??
              (existingTaskRun.machinePreset as MachinePresetName) ??
              undefined,
            lockToVersion:
              overrideOptions.version === "latest" ? undefined : overrideOptions.version,
            bulkActionId: overrideOptions?.bulkActionId,
            region,
            priority: overrideOptions.prioritySeconds,
          },
        },
        {
          spanParentAsLink: true,
          parentAsLinkType: "replay",
          replayedFromTaskRunFriendlyId: existingTaskRun.friendlyId,
          traceContext: {
            traceparent: `00-${existingTaskRun.traceId}-${existingTaskRun.spanId}-01`,
          },
          realtimeStreamsVersion: determineRealtimeStreamsVersion(
            existingTaskRun.realtimeStreamsVersion,
            authenticatedEnvironment.organization.streamBasinName
          ),
          triggerSource: overrideOptions.triggerSource ?? "api",
          triggerAction: "replay",
        }
      );

      return result?.run;
    } catch (error) {
      if (error instanceof OutOfEntitlementError) {
        return;
      }

      if (
        error instanceof ServiceValidationError ||
        error instanceof EngineServiceValidationError
      ) {
        throw error;
      }

      logger.error("Failed to replay a run", {
        error: error instanceof Error ? error.message : error,
      });

      return;
    }
  }

  private async overrideExistingPayloadPacket(
    existingTaskRun: TaskRun,
    stringifiedPayloadOverride: string | undefined,
    payloadType: "application/json" | "application/super+json" | undefined
  ) {
    if (stringifiedPayloadOverride === undefined) {
      return conditionallyImportPacket({
        data: existingTaskRun.payload,
        dataType: existingTaskRun.payloadType,
      });
    }

    if (payloadType) {
      return { data: stringifiedPayloadOverride, dataType: payloadType };
    }

    if (existingTaskRun.payloadType === "application/super+json") {
      const newPayload = await replaceSuperJsonPayload(
        existingTaskRun.payload,
        stringifiedPayloadOverride
      );

      return stringifyIO(newPayload);
    }

    return { data: stringifiedPayloadOverride, dataType: "application/json" };
  }

  private async getExistingMetadata(existingTaskRun: TaskRun) {
    if (!existingTaskRun.seedMetadata) {
      return undefined;
    }

    return parsePacket({
      data: existingTaskRun.seedMetadata,
      dataType: existingTaskRun.seedMetadataType,
    });
  }
}
