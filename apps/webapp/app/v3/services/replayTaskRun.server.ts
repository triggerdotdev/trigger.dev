import {
  type MachinePresetName,
  conditionallyImportPacket,
  parsePacket,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { type TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { type RunOptionsData } from "../testTask";
import { replaceSuperJsonPayload } from "@trigger.dev/core/v3/utils/ioSerialization";

type OverrideOptions = {
  environmentId?: string;
  payload?: string;
  metadata?: unknown;
  bulkActionId?: string;
} & RunOptionsData;

export class ReplayTaskRunService extends BaseService {
  public async call(existingTaskRun: TaskRun, overrideOptions: OverrideOptions = {}) {
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
      overrideOptions.payload
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
    const region = ignoreRegion ? undefined : existingTaskRun.workerQueue;

    try {
      const taskQueue = await this._prisma.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: authenticatedEnvironment.id,
          name: overrideOptions.queue ?? existingTaskRun.queue,
        },
      });

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
            delay: overrideOptions.delaySeconds
              ? new Date(Date.now() + overrideOptions.delaySeconds * 1000)
              : undefined,
            ttl: overrideOptions.ttlSeconds,
            idempotencyKey: overrideOptions.idempotencyKey,
            idempotencyKeyTTL: overrideOptions.idempotencyKeyTTLSeconds
              ? `${overrideOptions.idempotencyKeyTTLSeconds}s`
              : undefined,
            concurrencyKey:
              overrideOptions.concurrencyKey ?? existingTaskRun.concurrencyKey ?? undefined,
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
          },
        },
        {
          spanParentAsLink: true,
          parentAsLinkType: "replay",
          replayedFromTaskRunFriendlyId: existingTaskRun.friendlyId,
          traceContext: {
            traceparent: `00-${existingTaskRun.traceId}-${existingTaskRun.spanId}-01`,
          },
        }
      );

      return result?.run;
    } catch (error) {
      if (error instanceof OutOfEntitlementError) {
        return;
      }

      logger.error("Failed to replay a run", {
        error: error instanceof Error ? error.message : error,
      });

      return;
    }
  }

  private async overrideExistingPayloadPacket(
    existingTaskRun: TaskRun,
    stringifiedPayloadOverride: string | undefined
  ) {
    if (existingTaskRun.payloadType === "application/store") {
      return conditionallyImportPacket({
        data: existingTaskRun.payload,
        dataType: existingTaskRun.payloadType,
      });
    }

    if (stringifiedPayloadOverride && existingTaskRun.payloadType === "application/super+json") {
      const newPayload = await replaceSuperJsonPayload(
        existingTaskRun.payload,
        stringifiedPayloadOverride
      );

      return stringifyIO(newPayload);
    }

    return conditionallyImportPacket({
      data: stringifiedPayloadOverride ?? existingTaskRun.payload,
      dataType: existingTaskRun.payloadType,
    });
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
