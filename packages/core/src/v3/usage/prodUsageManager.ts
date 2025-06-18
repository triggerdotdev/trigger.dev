import { setInterval } from "node:timers/promises";
import { UsageManager, UsageMeasurement, UsageSample } from "./types.js";
import { UsageClient } from "./usageClient.js";

export type ProdUsageManagerOptions = {
  heartbeatIntervalMs?: number;
  url?: string;
  jwt?: string;
};

export class ProdUsageManager implements UsageManager {
  private _measurement: UsageMeasurement | undefined;
  private _abortController: AbortController | undefined;
  private _lastSample: UsageSample | undefined;
  private _usageClient: UsageClient | undefined;

  constructor(
    private readonly delegageUsageManager: UsageManager,
    private readonly options: ProdUsageManagerOptions
  ) {
    if (this.options.url && this.options.jwt) {
      this._usageClient = new UsageClient(this.options.url, this.options.jwt);
    }
  }

  get isReportingEnabled() {
    return typeof this._usageClient !== "undefined";
  }

  reset(): void {
    this.delegageUsageManager.reset();
    this._abortController = new AbortController();
    this._usageClient = undefined;
    this._measurement = undefined;
    this._lastSample = undefined;
  }

  disable(): void {
    this.delegageUsageManager.disable();
    this._abortController?.abort();
  }

  sample(): UsageSample | undefined {
    return this._measurement?.sample();
  }

  start(): UsageMeasurement {
    if (!this.isReportingEnabled || !this.options.heartbeatIntervalMs) {
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
    if (!this._measurement || !this.isReportingEnabled || !this.options.heartbeatIntervalMs) {
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

  async flush() {
    return await this.#reportUsage();
  }

  async #reportUsage() {
    if (!this._measurement) {
      return;
    }

    if (!this.isReportingEnabled) {
      return;
    }

    const client = this._usageClient;

    if (!client) {
      return;
    }

    const sample = this._measurement.sample();

    const cpuTimeSinceLastSample = this._lastSample
      ? sample.cpuTime - this._lastSample.cpuTime
      : sample.cpuTime;

    this._lastSample = sample;

    if (cpuTimeSinceLastSample <= 0) {
      return;
    }

    await client.sendUsageEvent({ durationMs: cpuTimeSinceLastSample });
  }
}
