import {
  conditionallyImportPacket,
  IOPacket,
  parsePacket,
  RunTags,
  stringifyIO,
} from "@trigger.dev/core/v3";
import { replaceSuperJsonPayload } from "@trigger.dev/core/v3/utils/ioSerialization";
import { TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { getTagsForRunId } from "~/models/taskRunTag.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";

type OverrideOptions = {
  environmentId?: string;
  payload?: string;
};

export class ReplayTaskRunService extends BaseService {
  public async call(existingTaskRun: TaskRun, overrideOptions?: OverrideOptions) {
    const authenticatedEnvironment = await findEnvironmentById(
      overrideOptions?.environmentId ?? existingTaskRun.runtimeEnvironmentId
    );
    if (!authenticatedEnvironment) {
      return;
    }

    if (authenticatedEnvironment.archivedAt) {
      return;
    }

    logger.info("Replaying task run", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
    });

    let payloadPacket: IOPacket;

    if (overrideOptions?.payload) {
      if (existingTaskRun.payloadType === "application/super+json") {
        const newPayload = await replaceSuperJsonPayload(
          existingTaskRun.payload,
          overrideOptions.payload
        );
        payloadPacket = await stringifyIO(newPayload);
      } else {
        payloadPacket = await conditionallyImportPacket({
          data: overrideOptions.payload,
          dataType: existingTaskRun.payloadType,
        });
      }
    } else {
      payloadPacket = await conditionallyImportPacket({
        data: existingTaskRun.payload,
        dataType: existingTaskRun.payloadType,
      });
    }

    const parsedPayload =
      payloadPacket.dataType === "application/json"
        ? await parsePacket(payloadPacket)
        : payloadPacket.data;

    logger.info("Replaying task run payload", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
      payloadPacketType: payloadPacket.dataType,
    });

    const metadata = existingTaskRun.seedMetadata
      ? await parsePacket({
          data: existingTaskRun.seedMetadata,
          dataType: existingTaskRun.seedMetadataType,
        })
      : undefined;

    try {
      const tags = await getTagsForRunId({
        friendlyId: existingTaskRun.friendlyId,
        environmentId: authenticatedEnvironment.id,
      });

      //get the queue from the original run, so we can use the same settings on the replay
      const taskQueue = await this._prisma.taskQueue.findFirst({
        where: {
          runtimeEnvironmentId: authenticatedEnvironment.id,
          name: existingTaskRun.queue,
        },
      });

      const triggerTaskService = new TriggerTaskService();
      const result = await triggerTaskService.call(
        existingTaskRun.taskIdentifier,
        authenticatedEnvironment,
        {
          payload: parsedPayload,
          options: {
            queue: taskQueue
              ? {
                  name: taskQueue.name,
                }
              : undefined,
            concurrencyKey: existingTaskRun.concurrencyKey ?? undefined,
            test: existingTaskRun.isTest,
            payloadType: payloadPacket.dataType,
            tags: tags?.map((t) => t.name) as RunTags,
            metadata,
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
