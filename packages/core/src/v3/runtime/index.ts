const API_NAME = "runtime";

import {
  BatchTaskRunExecutionResult,
  TaskRunContext,
  TaskRunExecutionResult,
  WaitpointTokenResult,
} from "../schemas/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { type RuntimeManager } from "./manager.js";
import { NoopRuntimeManager } from "./noopRuntimeManager.js";
import { usage } from "../usage-api.js";

const NOOP_RUNTIME_MANAGER = new NoopRuntimeManager();

/**
 * All state must be inside the RuntimeManager, do NOT store it on this class.
 * This is because of the "dual package hazard", this can be bundled multiple times.
 */
export class RuntimeAPI {
  private static _instance?: RuntimeAPI;

  private constructor() {}

  public static getInstance(): RuntimeAPI {
    if (!this._instance) {
      this._instance = new RuntimeAPI();
    }

    return this._instance;
  }

  public waitUntil(waitpointFriendlyId: string, finishDate?: Date): Promise<WaitpointTokenResult> {
    return usage.pauseAsync(() =>
      this.#getRuntimeManager().waitForWaitpoint({ waitpointFriendlyId, finishDate })
    );
  }

  public waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return usage.pauseAsync(() => this.#getRuntimeManager().waitForTask(params));
  }

  public waitForToken(waitpointFriendlyId: string): Promise<WaitpointTokenResult> {
    return usage.pauseAsync(() =>
      this.#getRuntimeManager().waitForWaitpoint({ waitpointFriendlyId })
    );
  }

  public waitForBatch(params: {
    id: string;
    runCount: number;
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return usage.pauseAsync(() => this.#getRuntimeManager().waitForBatch(params));
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
}
