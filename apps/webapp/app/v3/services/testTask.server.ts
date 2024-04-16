import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";
import { TestTaskData } from "../testTask";

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
        });
      case "SCHEDULED":
      //todo put data into the correct format
      // return await triggerTaskService.call(data.taskIdentifier, authenticatedEnvironment, {
      //   payload: data.payload,
      //   options: {
      //     scheduled: true,
      //   },
      // });
      default:
        throw new Error("Invalid trigger source");
    }
  }
}
