import { conditionallyImportPacket, IOPacket, parsePacket, RunTags } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "./triggerTask.server";
import { getTagsForRunId } from "~/models/taskRunTag.server";

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

    logger.info("Replaying task run", {
      taskRunId: existingTaskRun.id,
      taskRunFriendlyId: existingTaskRun.friendlyId,
    });

    let payloadPacket: IOPacket;

    if (overrideOptions?.payload) {
      payloadPacket = await conditionallyImportPacket({
        data: overrideOptions.payload,
        dataType: "application/json",
      });
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

    try {
      const tags = await getTagsForRunId({
        friendlyId: existingTaskRun.friendlyId,
        environmentId: authenticatedEnvironment.id,
      });

      const triggerTaskService = new TriggerTaskService();
      return await triggerTaskService.call(
        existingTaskRun.taskIdentifier,
        authenticatedEnvironment,
        {
          payload: parsedPayload,
          options: {
            queue: {
              name: existingTaskRun.queue,
            },
            concurrencyKey: existingTaskRun.concurrencyKey ?? undefined,
            test: existingTaskRun.isTest,
            payloadType: payloadPacket.dataType,
            tags: tags?.map((t) => t.name) as RunTags,
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
    } catch (error) {
      if (error instanceof OutOfEntitlementError) {
        return;
      }

      logger.error("Failed to replay a run", { error: error });

      return;
    }
  }
}
