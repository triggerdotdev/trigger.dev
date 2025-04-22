import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { RunNumberIncrementer, TriggerTaskRequest } from "../types";

export class DefaultRunNumberIncrementer implements RunNumberIncrementer {
  async incrementRunNumber<T>(
    request: TriggerTaskRequest,
    callback: (num: number) => Promise<T>
  ): Promise<T | undefined> {
    return await autoIncrementCounter.incrementInTransaction(
      `v3-run:${request.environment.id}:${request.taskId}`,
      callback
    );
  }
}
