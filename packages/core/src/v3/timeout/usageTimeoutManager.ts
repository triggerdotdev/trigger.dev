import { UsageManager } from "../usage/types.js";
import { TaskRunExceededMaxDuration, TimeoutManager } from "./types.js";

export class UsageTimeoutManager implements TimeoutManager {
  private _abortController: AbortController;
  private _abortSignal: AbortSignal | undefined;
  private _intervalId: NodeJS.Timeout | undefined;
  private _listener?: (
    timeoutInSeconds: number,
    elapsedTimeInSeconds: number
  ) => void | Promise<void>;

  constructor(private readonly usageManager: UsageManager) {
    this._abortController = new AbortController();
  }

  registerListener(
    listener: (timeoutInSeconds: number, elapsedTimeInSeconds: number) => void | Promise<void>
  ): void {
    this._listener = listener;
  }

  get signal(): AbortSignal | undefined {
    return this._abortSignal;
  }

  reset(): void {
    this._abortController = new AbortController();
    this._abortSignal = undefined;

    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = undefined;
    }
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

          const elapsedTimeInSeconds = sample.cpuTime / 1000;

          // Call the listener if registered
          if (this._listener) {
            this._listener(timeoutInSeconds, elapsedTimeInSeconds);
          }

          this._abortController.abort(
            new TaskRunExceededMaxDuration(timeoutInSeconds, elapsedTimeInSeconds)
          );
        }
      }
    }, 1000);

    return this._abortController;
  }
}
