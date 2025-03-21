const API_NAME = "lifecycle-hooks";

import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { NoopLifecycleHooksManager } from "./manager.js";
import {
  AnyOnInitHookFunction,
  RegisteredHookFunction,
  RegisterHookFunctionParams,
  type LifecycleHooksManager,
} from "./types.js";

const NOOP_LIFECYCLE_HOOKS_MANAGER = new NoopLifecycleHooksManager();

export class LifecycleHooksAPI {
  private static _instance?: LifecycleHooksAPI;

  private constructor() {}

  public static getInstance(): LifecycleHooksAPI {
    if (!this._instance) {
      this._instance = new LifecycleHooksAPI();
    }

    return this._instance;
  }

  public setGlobalLifecycleHooksManager(lifecycleHooksManager: LifecycleHooksManager): boolean {
    return registerGlobal(API_NAME, lifecycleHooksManager);
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  public registerGlobalInitHook(hook: RegisterHookFunctionParams<AnyOnInitHookFunction>): void {
    this.#getManager().registerGlobalInitHook(hook);
  }

  public registerTaskInitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnInitHookFunction>
  ): void {
    this.#getManager().registerTaskInitHook(taskId, hook);
  }

  public getTaskInitHook(taskId: string): AnyOnInitHookFunction | undefined {
    return this.#getManager().getTaskInitHook(taskId);
  }

  public getGlobalInitHooks(): RegisteredHookFunction<AnyOnInitHookFunction>[] {
    return this.#getManager().getGlobalInitHooks();
  }

  #getManager(): LifecycleHooksManager {
    return getGlobal(API_NAME) ?? NOOP_LIFECYCLE_HOOKS_MANAGER;
  }
}
