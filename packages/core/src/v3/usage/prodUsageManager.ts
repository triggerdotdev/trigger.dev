import { setInterval } from "node:timers/promises";
import type { InitialUsageState, UsageManager, UsageMeasurement, UsageSample } from "./types.js";
import { randomUUID } from "../utils/crypto.js";
import { UsageClient } from "./usageClient.js";

// Billing clamps larger deltas, so drain any rejected-report backlog in bounded chunks.
const MAX_USAGE_REPORT_DURATION_MS = 24 * 60 * 60 * 1_000;
// Billing dedups report ids for longer than this; past it a retry could be counted twice.
const MAX_IN_DOUBT_AGE_MS = 60 * 60 * 1_000;

type InDoubtReport = { id: string; durationMs: number; firstSentAt: number };

export type ProdUsageManagerOptions = {
  heartbeatIntervalMs?: number;
  url?: string;
  jwt?: string;
  /** Resend reports with no definite answer under the same id. Needs billing-side dedup. */
  retryAmbiguousReports?: boolean;
};

export function isUsageReportingEnabled(options: ProdUsageManagerOptions): boolean {
  return Boolean(options.url && options.jwt && options.heartbeatIntervalMs);
}

export class ProdUsageManager implements UsageManager {
  private _measurement: UsageMeasurement | undefined;
  private _abortController: AbortController | undefined;
  private _lastSample: UsageSample | undefined;
  private _usageClient: UsageClient | undefined;
  private _reporting: Promise<void> | undefined;
  private _pendingDurationMs = 0;
  private _inDoubt: InDoubtReport | undefined;
  private _initialState: InitialUsageState = {
    cpuTime: 0,
    costInCents: 0,
  };

  constructor(
    private readonly delegageUsageManager: UsageManager,
    private readonly options: ProdUsageManagerOptions
  ) {
    if (isUsageReportingEnabled(this.options)) {
      this._usageClient = new UsageClient(this.options.url!, this.options.jwt!);
    }
  }

  get isReportingEnabled() {
    return typeof this._usageClient !== "undefined";
  }

  setJwt(jwt: string): boolean {
    if (!this._usageClient) return false;
    this._usageClient.setJwt(jwt);
    return true;
  }

  setInitialState(state: InitialUsageState) {
    this._initialState = state;
  }

  getInitialState(): InitialUsageState {
    return this._initialState;
  }

  reset(): void {
    this.#reportUnsentUsage();
    this.delegageUsageManager.reset();
    this._abortController?.abort();
    this._abortController = new AbortController();
    this._usageClient = undefined;
    this._measurement = undefined;
    this._lastSample = undefined;
    this._pendingDurationMs = 0;
    this._inDoubt = undefined;
    this._initialState = {
      cpuTime: 0,
      costInCents: 0,
    };
  }

  disable(): void {
    this.#reportUnsentUsage();
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

    try {
      for await (const _ of setInterval(this.options.heartbeatIntervalMs, undefined, {
        signal: this._abortController.signal,
      })) {
        await this.#reportUsage();
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }

      throw error;
    }
  }

  async flush() {
    // A heartbeat sampled before this flush. Wait, then take a final sample rather than sharing
    // its result and losing the CPU accumulated while that request was in flight.
    while (this._reporting) await this._reporting;
    await this.#reportUsage();
  }

  #reportUsage(): Promise<void> {
    // Keep periodic reporting single-flight; flush waits and samples again.
    if (this._reporting) return this._reporting;
    this._reporting = this.#sendPendingUsage().finally(() => {
      this._reporting = undefined;
    });
    return this._reporting;
  }

  #reportUnsentUsage() {
    if (this._pendingDurationMs > 0 || this._inDoubt) {
      console.error("Unacknowledged usage remains at teardown", {
        durationMs: this._pendingDurationMs,
        inDoubtDurationMs: this._inDoubt?.durationMs ?? 0,
      });
    }
  }

  /** Returns true while a report is still in doubt, so no new usage is sent ahead of it. */
  async #resendInDoubt(client: UsageClient): Promise<boolean> {
    const report = this._inDoubt;
    if (!report) return false;

    if (Date.now() - report.firstSentAt > MAX_IN_DOUBT_AGE_MS) {
      console.error("Dropping usage report still in doubt", { durationMs: report.durationMs });
      this._inDoubt = undefined;
      return false;
    }

    // A 401 leaves it in doubt too: an earlier send of the same id may already be recorded.
    const result = await client.sendUsageEvent({ durationMs: report.durationMs }, report.id);
    if (result !== "accepted" || this._usageClient !== client) return true;

    this._inDoubt = undefined;
    return false;
  }

  async #sendPendingUsage() {
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
    this._pendingDurationMs += Math.max(0, cpuTimeSinceLastSample);

    if (await this.#resendInDoubt(client)) return;

    const durationMs = Math.min(this._pendingDurationMs, MAX_USAGE_REPORT_DURATION_MS);
    if (durationMs <= 0) return;

    const id = this.options.retryAmbiguousReports ? await randomUUID() : undefined;
    const result = await client.sendUsageEvent({ durationMs }, id);
    if (result === "rejected" || this._usageClient !== client) return;

    this._pendingDurationMs -= durationMs;
    if (result === "unknown" && id) {
      this._inDoubt = { id, durationMs, firstSentAt: Date.now() };
    }
  }
}
