import { stringifyIO } from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { TestTaskData } from "../testTask";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";

export class TestTaskService extends BaseService {
  public async call(environment: AuthenticatedEnvironment, data: TestTaskData) {
    const triggerTaskService = new TriggerTaskService();

    switch (data.triggerSource) {
      case "STANDARD": {
        const result = await triggerTaskService.call(data.taskIdentifier, environment, {
          payload: data.payload,
          options: {
            test: true,
            metadata: data.metadata,
          },
        });

        return result?.run;
      }
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

        const result = await triggerTaskService.call(
          data.taskIdentifier,
          environment,
          {
            payload: payloadPacket.data,
            options: { payloadType: payloadPacket.dataType, test: true },
          },
          { customIcon: "scheduled" }
        );

        return result?.run;
      }
      default:
        throw new Error("Invalid trigger source");
    }
  }
}
