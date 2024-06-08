import { setInterval } from "node:timers/promises";
import { UsageManager, UsageMeasurement, UsageSample } from "./types";
import { UsageClient, UsageClientOptions } from "./usageClient";

export type ProdUsageManagerOptions = {
  heartbeatIntervalMs?: number;
  client?: UsageClientOptions;
  subject: string;
  machinePreset?: string;
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
    if (typeof this.options.client !== "undefined") {
      this._usageClient = new UsageClient(this.options.client);
    }
  }

  get isReportingEnabled() {
    return typeof this.options.client !== "undefined";
  }

  disable(): void {
    this.delegageUsageManager.disable();
    this._abortController?.abort();
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
    console.log("Flushing usage");

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
    const wallTimeSinceLastSample = this._lastSample
      ? sample.wallTime - this._lastSample.wallTime
      : sample.wallTime;

    const cpuTimeSinceLastSample = this._lastSample
      ? sample.cpuTime - this._lastSample.cpuTime
      : sample.cpuTime;

    this._lastSample = sample;

    console.log("Reporting usage", {
      wallTimeSinceLastSample,
      cpuTimeSinceLastSample,
      subject: this.options.subject,
      machine: this.options.machinePreset,
    });

    if (cpuTimeSinceLastSample <= 0) {
      return;
    }

    const now = performance.now();

    const event = {
      source: "prod-usage-manager",
      type: "usage",
      subject: this.options.subject,
      data: {
        durationMs: cpuTimeSinceLastSample,
        wallTimeInMs: wallTimeSinceLastSample,
        machinePreset: this.options.machinePreset ?? "unknown",
      },
    };

    await client.sendUsageEvent(event);

    const durationInMs = performance.now() - now;

    console.log("Reported usage", {
      durationInMs,
      event,
    });
  }
}
