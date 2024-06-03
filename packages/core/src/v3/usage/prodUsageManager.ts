import { UsageManager, UsageMeasurement, UsageSample } from "./types";
import { setInterval } from "node:timers/promises";
import { OpenMeter } from "@openmeter/sdk";

export type ProdUsageManagerOptions = {
  heartbeatIntervalMs?: number;
  openMeter?: {
    baseUrl: string;
    token: string;
  };
  subject: string;
  machinePreset?: string;
};

export class ProdUsageManager implements UsageManager {
  private _measurement: UsageMeasurement | undefined;
  private _abortController: AbortController | undefined;
  private _openMeter: OpenMeter | undefined;
  private _lastSample: UsageSample | undefined;

  constructor(
    private readonly delegageUsageManager: UsageManager,
    private readonly options: ProdUsageManagerOptions
  ) {
    this._openMeter = options.openMeter ? new OpenMeter(options.openMeter) : undefined;
  }

  disable(): void {
    this.delegageUsageManager.disable();
    this._abortController?.abort();
  }

  start(): UsageMeasurement {
    if (!this._openMeter || !this.options.heartbeatIntervalMs) {
      return this.delegageUsageManager.start();
    }

    if (!this._measurement) {
      this._measurement = this.delegageUsageManager.start();

      this.#startReportingHeartbeat().catch(console.error);

      return this._measurement;
    }

    return this.delegageUsageManager.start();
  }

  stop(measurement: UsageMeasurement): UsageSample {
    return this.delegageUsageManager.stop(measurement);
  }

  async pauseAsync<T>(cb: () => Promise<T>): Promise<T> {
    return this.delegageUsageManager.pauseAsync(cb);
  }

  async #startReportingHeartbeat() {
    if (!this._measurement || !this._openMeter || !this.options.heartbeatIntervalMs) {
      return;
    }

    this._abortController = new AbortController();

    for await (const _ of setInterval(this.options.heartbeatIntervalMs)) {
      if (this._abortController.signal.aborted) {
        break;
      }

      await this.#reportUsage();
    }
  }

  async #reportUsage() {
    if (!this._measurement) {
      return;
    }

    if (!this._openMeter) {
      return;
    }

    const sample = this._measurement.sample();
    const wallTimeSinceLastSample = this._lastSample
      ? sample.wallTime - this._lastSample.wallTime
      : sample.wallTime;

    const cpuTimeSinceLastSample = this._lastSample
      ? sample.cpuTime - this._lastSample.cpuTime
      : sample.cpuTime;

    this._lastSample = sample;

    await this._openMeter.events.ingest({
      source: "prod-usage-manager",
      type: "usage",
      time: new Date(),
      subject: this.options.subject,
      data: {
        cpuTimeInMs: cpuTimeSinceLastSample,
        wallTimeInMs: wallTimeSinceLastSample,
        durationSeconds: cpuTimeSinceLastSample / 1000,
        machinePreset: this.options.machinePreset ?? "unknown",
      },
    });
  }
}

// const startUsageHeartbeat = async (
//   measurement: UsageMeasurement,
//   execution: TaskRunExecution,
//   worker: BackgroundWorkerProperties
// ) => {
//   const abortController = new AbortController();

//   // Every scanIntervalMs, check if delay has elapsed

//   return abortController;
// };

// const stopUsageHeartbeat = (abortController: AbortController) => {
//   abortController.abort();
// };
