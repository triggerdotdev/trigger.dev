const API_NAME = "usage";

import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import type { InitialUsageState, UsageManager, UsageMeasurement, UsageSample } from "./types.js";
import { NoopUsageManager } from "./noopUsageManager.js";

const NOOP_USAGE_MANAGER = new NoopUsageManager();

export class UsageAPI implements UsageManager {
  private static _instance?: UsageAPI;

  private constructor() {}

  public static getInstance(): UsageAPI {
    if (!this._instance) {
      this._instance = new UsageAPI();
    }

    return this._instance;
  }

  public setGlobalUsageManager(manager: UsageManager): boolean {
    return registerGlobal(API_NAME, manager);
  }

  public disable() {
    this.#getUsageManager().disable();
    unregisterGlobal(API_NAME);
  }

  public start(): UsageMeasurement {
    return this.#getUsageManager().start();
  }

  public stop(measurement: UsageMeasurement): UsageSample {
    return this.#getUsageManager().stop(measurement);
  }

  public pauseAsync<T>(cb: () => Promise<T>): Promise<T> {
    return this.#getUsageManager().pauseAsync(cb);
  }

  public sample(): UsageSample | undefined {
    return this.#getUsageManager().sample();
  }

  public flush(): Promise<void> {
    return this.#getUsageManager().flush();
  }

  public reset() {
    this.#getUsageManager().reset();
    this.disable();
  }

  public getInitialState(): InitialUsageState {
    return this.#getUsageManager().getInitialState();
  }

  #getUsageManager(): UsageManager {
    return getGlobal(API_NAME) ?? NOOP_USAGE_MANAGER;
  }
}
