export interface TimeoutManager {
  abortAfterTimeout: (timeoutInSeconds?: number) => AbortController;
  signal?: AbortSignal;
  reset: () => void;
  registerListener?: (listener: (timeoutInSeconds: number, elapsedTimeInSeconds: number) => void | Promise<void>) => void;
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
