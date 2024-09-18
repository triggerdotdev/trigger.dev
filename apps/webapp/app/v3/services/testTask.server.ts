import { stringifyIO } from "@trigger.dev/core/v3";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { TestTaskData } from "../testTask";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";

export class TestTaskService extends BaseService {
  public async call(userId: string, data: TestTaskData) {
    const authenticatedEnvironment = await findEnvironmentById(data.environmentId);
    if (!authenticatedEnvironment) {
      return;
    }

    const triggerTaskService = new TriggerTaskService();

    switch (data.triggerSource) {
      case "STANDARD":
        return await triggerTaskService.call(data.taskIdentifier, authenticatedEnvironment, {
          payload: data.payload,
          options: {
            test: true,
          },
        });
      case "SCHEDULED": {
        const payload = {
          scheduleId: "sched_1234",
          type: "IMPERATIVE",
          timestamp: data.timestamp,
          lastTimestamp: data.lastTimestamp,
          timezone: data.timezone,
          externalId: data.externalId,
          upcoming: [],
        };
        const payloadPacket = await stringifyIO(payload);

        return await triggerTaskService.call(
          data.taskIdentifier,
          authenticatedEnvironment,
          {
            payload: payloadPacket.data,
            options: { payloadType: payloadPacket.dataType, test: true },
          },
          { customIcon: "scheduled" }
        );
      }
      default:
        throw new Error("Invalid trigger source");
    }
  }
}
