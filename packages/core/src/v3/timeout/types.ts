export interface TimeoutManager {
  abortAfterTimeout: (timeoutInSeconds: number) => AbortSignal;
  signal?: AbortSignal;
}

export class TaskRunExceededMaxDuration extends Error {
  constructor(
    public readonly timeoutInSeconds: number,
    public readonly usageInSeconds: number
  ) {
    super(`Run exceeded maxDuration of ${timeoutInSeconds} seconds`);
    this.name = "TaskRunExceededMaxDuration";
  }
}
