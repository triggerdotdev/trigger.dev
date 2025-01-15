const API_NAME = "runtime";

import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { type RuntimeManager } from "./manager.js";
import { NoopRuntimeManager } from "./noopRuntimeManager.js";
import { usage } from "../usage-api.js";

const NOOP_RUNTIME_MANAGER = new NoopRuntimeManager();

const concurrentWaitErrorMessage =
  "Parallel waits are not supported, e.g. using Promise.all() around our wait functions.";

/**
 * All state must be inside the RuntimeManager, do NOT store it on this class.
 * This is because of the "dual package hazard", this can be bundled multiple times.
 */
export class RuntimeAPI {
  private static _instance?: RuntimeAPI;
  private isExecutingWait = false;

  private constructor() {}

  public static getInstance(): RuntimeAPI {
    if (!this._instance) {
      this._instance = new RuntimeAPI();
    }

    return this._instance;
  }

  public waitForDuration(ms: number): Promise<void> {
    return this.#preventConcurrentWaits(() =>
      usage.pauseAsync(() => this.#getRuntimeManager().waitForDuration(ms))
    );
  }

  public waitUntil(date: Date): Promise<void> {
    return this.#preventConcurrentWaits(() =>
      usage.pauseAsync(() => this.#getRuntimeManager().waitUntil(date))
    );
  }

  public waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this.#preventConcurrentWaits(() =>
      usage.pauseAsync(() => this.#getRuntimeManager().waitForTask(params))
    );
  }

  public waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return this.#preventConcurrentWaits(() =>
      usage.pauseAsync(() => this.#getRuntimeManager().waitForBatch(params))
    );
  }

  public setGlobalRuntimeManager(runtimeManager: RuntimeManager): boolean {
    return registerGlobal(API_NAME, runtimeManager);
  }

  public disable() {
    this.#getRuntimeManager().disable();
    unregisterGlobal(API_NAME);
  }

  #getRuntimeManager(): RuntimeManager {
    return getGlobal(API_NAME) ?? NOOP_RUNTIME_MANAGER;
  }

  async #preventConcurrentWaits<T>(cb: () => Promise<T>): Promise<T> {
    if (this.isExecutingWait) {
      console.error(concurrentWaitErrorMessage);
      throw new Error(concurrentWaitErrorMessage);
    }

    this.isExecutingWait = true;

    try {
      return await cb();
    } finally {
      this.isExecutingWait = false;
    }
  }
}
