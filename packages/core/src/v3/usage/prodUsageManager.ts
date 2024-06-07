import { randomUUID } from "node:crypto";
import { UsageManager, UsageMeasurement, UsageSample } from "./types";
import { setInterval } from "node:timers/promises";

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
  private _lastSample: UsageSample | undefined;

  constructor(
    private readonly delegageUsageManager: UsageManager,
    private readonly options: ProdUsageManagerOptions
  ) {}

  get isOpenMeterEnabled() {
    return typeof this.options.openMeter !== "undefined";
  }

  disable(): void {
    this.delegageUsageManager.disable();
    this._abortController?.abort();
  }

  start(): UsageMeasurement {
    if (!this.isOpenMeterEnabled || !this.options.heartbeatIntervalMs) {
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
    if (!this._measurement || !this.isOpenMeterEnabled || !this.options.heartbeatIntervalMs) {
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

    if (!this.isOpenMeterEnabled) {
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

    const body = {
      specversion: "1.0",
      id: randomUUID(),
      source: "prod-usage-manager",
      type: "usage",
      time: new Date().toISOString(),
      subject: this.options.subject,
      datacontenttype: "application/json",
      data: {
        durationMs: cpuTimeSinceLastSample,
        wallTimeInMs: wallTimeSinceLastSample,
        machinePreset: this.options.machinePreset ?? "unknown",
      },
    };

    const url = `${this.options.openMeter!.baseUrl}/api/v1/events`;

    const now = performance.now();

    try {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "Content-Type": "application/cloudevents+json",
          Authorization: `Bearer ${this.options.openMeter!.token}`,
          Accept: "application/json",
        },
      });

      const durationInMs = performance.now() - now;

      if (!response.ok) {
        console.error(
          "Failed to report usage",
          response.status,
          response.statusText,
          body,
          durationInMs
        );
      }

      console.log("Reported usage", {
        durationInMs,
        status: response.status,
        statusText: response.statusText,
        body,
      });
    } catch (error) {
      console.error("Reported usage failed", {
        durationInMs: performance.now() - now,
        error,
      });
    }
  }
}
