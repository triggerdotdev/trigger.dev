import { UsageManager } from "../usage/types.js";
import { TaskRunExceededMaxDuration, TimeoutManager } from "./types.js";

export class UsageTimeoutManager implements TimeoutManager {
  private _abortController: AbortController;
  private _abortSignal: AbortSignal | undefined;
  private _intervalId: NodeJS.Timeout | undefined;

  constructor(private readonly usageManager: UsageManager) {
    this._abortController = new AbortController();
  }

  get signal(): AbortSignal | undefined {
    return this._abortSignal;
  }

  reset(): void {
    this._abortController = new AbortController();
    this._abortSignal = undefined;
    this._intervalId = undefined;
  }

  abortAfterTimeout(timeoutInSeconds?: number): AbortController {
    this._abortSignal = this._abortController.signal;

    if (!timeoutInSeconds) {
      return this._abortController;
    }

    if (this._intervalId) {
      clearInterval(this._intervalId);
    }

    // Now we need to start an interval that will measure usage and abort the signal if the usage is too high
    this._intervalId = setInterval(() => {
      const sample = this.usageManager.sample();
      if (sample) {
        if (sample.cpuTime > timeoutInSeconds * 1000) {
          clearInterval(this._intervalId);

          this._abortController.abort(
            new TaskRunExceededMaxDuration(timeoutInSeconds, sample.cpuTime / 1000)
          );
        }
      }
    }, 1000);

    return this._abortController;
  }
}
