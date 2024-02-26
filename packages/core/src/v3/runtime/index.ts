const API_NAME = "runtime";

import {
  BatchTaskRunExecutionResult,
  TaskMetadataWithFilePath,
  TaskRunContext,
  TaskRunExecutionResult,
} from "../schemas";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals";
import { type RuntimeManager } from "./manager";
import { NoopRuntimeManager } from "./noopRuntimeManager";

const NOOP_RUNTIME_MANAGER = new NoopRuntimeManager();

export class RuntimeAPI {
  private static _instance?: RuntimeAPI;

  private constructor() {}

  public static getInstance(): RuntimeAPI {
    if (!this._instance) {
      this._instance = new RuntimeAPI();
    }

    return this._instance;
  }

  public waitForDuration(ms: number): Promise<void> {
    return this.#getRuntimeManager().waitForDuration(ms);
  }

  public waitUntil(date: Date): Promise<void> {
    return this.#getRuntimeManager().waitUntil(date);
  }

  public waitForTask(params: { id: string; ctx: TaskRunContext }): Promise<TaskRunExecutionResult> {
    return this.#getRuntimeManager().waitForTask(params);
  }

  public waitForBatch(params: {
    id: string;
    runs: string[];
    ctx: TaskRunContext;
  }): Promise<BatchTaskRunExecutionResult> {
    return this.#getRuntimeManager().waitForBatch(params);
  }

  public setGlobalRuntimeManager(runtimeManager: RuntimeManager): boolean {
    return registerGlobal(API_NAME, runtimeManager);
  }

  public disable() {
    this.#getRuntimeManager().disable();
    unregisterGlobal(API_NAME);
  }

  public registerTasks(tasks: TaskMetadataWithFilePath[]): void {
    this.#getRuntimeManager().registerTasks(tasks);
  }

  public getTaskMetadata(id: string): TaskMetadataWithFilePath | undefined {
    return this.#getRuntimeManager().getTaskMetadata(id);
  }

  #getRuntimeManager(): RuntimeManager {
    return getGlobal(API_NAME) ?? NOOP_RUNTIME_MANAGER;
  }
}
