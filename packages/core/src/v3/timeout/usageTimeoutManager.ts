import { UsageManager } from "../usage/types.js";
import { TaskRunExceededMaxDuration, TimeoutManager } from "./types.js";

export class UsageTimeoutManager implements TimeoutManager {
  private _abortController: AbortController;
  private _abortSignal: AbortSignal | undefined;

  constructor(private readonly usageManager: UsageManager) {
    this._abortController = new AbortController();
  }

  get signal(): AbortSignal | undefined {
    return this._abortSignal;
  }

  abortAfterTimeout(timeoutInSeconds: number): AbortSignal {
    this._abortSignal = this._abortController.signal;

    // Now we need to start an interval that will measure usage and abort the signal if the usage is too high
    const intervalId = setInterval(() => {
      const sample = this.usageManager.sample();
      if (sample) {
        if (sample.cpuTime > timeoutInSeconds * 1000) {
          clearInterval(intervalId);

          this._abortController.abort(
            new TaskRunExceededMaxDuration(timeoutInSeconds, sample.cpuTime / 1000)
          );
        }
      }
    }, 1000);

    return this._abortSignal;
  }
}
