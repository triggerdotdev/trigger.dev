import {
  type MachinePresetName,
  conditionallyImportPacket,
  parsePacket,
} from "@trigger.dev/core/v3";
import { type TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { getTagsForRunId } from "~/models/taskRunTag.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { type RunOptionsData } from "../testTask";

type OverrideOptions = {
  environmentId?: string;
  payload?: unknown;
  metadata?: unknown;
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

    const getExistingPayload = async () => {
      const existingPayloadPacket = await conditionallyImportPacket({
        data: existingTaskRun.payload,
        dataType: existingTaskRun.payloadType,
      });

      return existingPayloadPacket.dataType === "application/json"
        ? await parsePacket(existingPayloadPacket)
        : existingPayloadPacket.data;
    };

    const payload = overrideOptions.payload ?? (await getExistingPayload());
    const metadata =
      overrideOptions.metadata ??
      (existingTaskRun.seedMetadata
        ? await parsePacket({
            data: existingTaskRun.seedMetadata,
            dataType: existingTaskRun.seedMetadataType,
          })
        : undefined);

    try {
      const tags =
        overrideOptions.tags ??
        (
          await getTagsForRunId({
            friendlyId: existingTaskRun.friendlyId,
            environmentId: authenticatedEnvironment.id,
          })
        )?.map((t) => t.name);

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
          payload,
          options: {
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
          },
        },
        {
          spanParentAsLink: true,
          parentAsLinkType: "replay",
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
}
