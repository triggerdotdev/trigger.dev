import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { BaseService } from "./baseService.server";
import { TriggerTaskService } from "./triggerTask.server";

type TestTaskServiceOptions = {
  taskIdentifier: string;
  environmentId: string;
  payload?: any;
};

export class TestTaskService extends BaseService {
  public async call(userId: string, data: TestTaskServiceOptions) {
    const authenticatedEnvironment = await findEnvironmentById(data.environmentId);
    if (!authenticatedEnvironment) {
      return;
    }

    const triggerTaskService = new TriggerTaskService();
    return await triggerTaskService.call(data.taskIdentifier, authenticatedEnvironment, {
      payload: data.payload,
      options: {
        test: true,
      },
    });
  }
}
