const API_NAME = "lifecycle-hooks";

import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { NoopLifecycleHooksManager } from "./manager.js";
import {
  AnyOnCatchErrorHookFunction,
  AnyOnCleanupHookFunction,
  AnyOnCompleteHookFunction,
  AnyOnFailureHookFunction,
  AnyOnInitHookFunction,
  AnyOnMiddlewareHookFunction,
  AnyOnResumeHookFunction,
  AnyOnStartHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnWaitHookFunction,
  AnyOnCancelHookFunction,
  RegisteredHookFunction,
  RegisterHookFunctionParams,
  TaskWait,
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

  public registerTaskStartHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnStartHookFunction>
  ): void {
    this.#getManager().registerTaskStartHook(taskId, hook);
  }

  public registerGlobalStartHook(hook: RegisterHookFunctionParams<AnyOnStartHookFunction>): void {
    this.#getManager().registerGlobalStartHook(hook);
  }

  public getTaskStartHook(taskId: string): AnyOnStartHookFunction | undefined {
    return this.#getManager().getTaskStartHook(taskId);
  }

  public getGlobalStartHooks(): RegisteredHookFunction<AnyOnStartHookFunction>[] {
    return this.#getManager().getGlobalStartHooks();
  }

  public registerGlobalFailureHook(
    hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>
  ): void {
    this.#getManager().registerGlobalFailureHook(hook);
  }

  public registerTaskFailureHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>
  ): void {
    this.#getManager().registerTaskFailureHook(taskId, hook);
  }

  public getTaskFailureHook(taskId: string): AnyOnFailureHookFunction | undefined {
    return this.#getManager().getTaskFailureHook(taskId);
  }

  public getGlobalFailureHooks(): RegisteredHookFunction<AnyOnFailureHookFunction>[] {
    return this.#getManager().getGlobalFailureHooks();
  }

  public registerGlobalSuccessHook(
    hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>
  ): void {
    this.#getManager().registerGlobalSuccessHook(hook);
  }

  public registerTaskSuccessHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>
  ): void {
    this.#getManager().registerTaskSuccessHook(taskId, hook);
  }

  public getTaskSuccessHook(taskId: string): AnyOnSuccessHookFunction | undefined {
    return this.#getManager().getTaskSuccessHook(taskId);
  }

  public getGlobalSuccessHooks(): RegisteredHookFunction<AnyOnSuccessHookFunction>[] {
    return this.#getManager().getGlobalSuccessHooks();
  }

  public registerGlobalCompleteHook(
    hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>
  ): void {
    this.#getManager().registerGlobalCompleteHook(hook);
  }

  public registerTaskCompleteHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>
  ): void {
    this.#getManager().registerTaskCompleteHook(taskId, hook);
  }

  public getTaskCompleteHook(taskId: string): AnyOnCompleteHookFunction | undefined {
    return this.#getManager().getTaskCompleteHook(taskId);
  }

  public getGlobalCompleteHooks(): RegisteredHookFunction<AnyOnCompleteHookFunction>[] {
    return this.#getManager().getGlobalCompleteHooks();
  }

  public registerGlobalWaitHook(hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>): void {
    this.#getManager().registerGlobalWaitHook(hook);
  }

  public registerTaskWaitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>
  ): void {
    this.#getManager().registerTaskWaitHook(taskId, hook);
  }

  public getTaskWaitHook(taskId: string): AnyOnWaitHookFunction | undefined {
    return this.#getManager().getTaskWaitHook(taskId);
  }

  public getGlobalWaitHooks(): RegisteredHookFunction<AnyOnWaitHookFunction>[] {
    return this.#getManager().getGlobalWaitHooks();
  }

  public registerGlobalResumeHook(hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>): void {
    this.#getManager().registerGlobalResumeHook(hook);
  }

  public registerTaskResumeHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>
  ): void {
    this.#getManager().registerTaskResumeHook(taskId, hook);
  }

  public getTaskResumeHook(taskId: string): AnyOnResumeHookFunction | undefined {
    return this.#getManager().getTaskResumeHook(taskId);
  }

  public getGlobalResumeHooks(): RegisteredHookFunction<AnyOnResumeHookFunction>[] {
    return this.#getManager().getGlobalResumeHooks();
  }

  public registerGlobalCatchErrorHook(
    hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>
  ): void {
    this.#getManager().registerGlobalCatchErrorHook(hook);
  }

  public registerTaskCatchErrorHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>
  ): void {
    this.#getManager().registerTaskCatchErrorHook(taskId, hook);
  }

  public getTaskCatchErrorHook(taskId: string): AnyOnCatchErrorHookFunction | undefined {
    return this.#getManager().getTaskCatchErrorHook(taskId);
  }

  public getGlobalCatchErrorHooks(): RegisteredHookFunction<AnyOnCatchErrorHookFunction>[] {
    return this.#getManager().getGlobalCatchErrorHooks();
  }

  public registerGlobalMiddlewareHook(
    hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>
  ): void {
    this.#getManager().registerGlobalMiddlewareHook(hook);
  }

  public registerTaskMiddlewareHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>
  ): void {
    this.#getManager().registerTaskMiddlewareHook(taskId, hook);
  }

  public getTaskMiddlewareHook(taskId: string): AnyOnMiddlewareHookFunction | undefined {
    return this.#getManager().getTaskMiddlewareHook(taskId);
  }

  public getGlobalMiddlewareHooks(): RegisteredHookFunction<AnyOnMiddlewareHookFunction>[] {
    return this.#getManager().getGlobalMiddlewareHooks();
  }

  public registerGlobalCleanupHook(
    hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>
  ): void {
    this.#getManager().registerGlobalCleanupHook(hook);
  }

  public registerTaskCleanupHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>
  ): void {
    this.#getManager().registerTaskCleanupHook(taskId, hook);
  }

  public getTaskCleanupHook(taskId: string): AnyOnCleanupHookFunction | undefined {
    return this.#getManager().getTaskCleanupHook(taskId);
  }

  public getGlobalCleanupHooks(): RegisteredHookFunction<AnyOnCleanupHookFunction>[] {
    return this.#getManager().getGlobalCleanupHooks();
  }

  public callOnWaitHookListeners(wait: TaskWait): Promise<void> {
    return this.#getManager().callOnWaitHookListeners(wait);
  }

  public callOnResumeHookListeners(wait: TaskWait): Promise<void> {
    return this.#getManager().callOnResumeHookListeners(wait);
  }

  public registerOnWaitHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    this.#getManager().registerOnWaitHookListener(listener);
  }

  public registerOnResumeHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    this.#getManager().registerOnResumeHookListener(listener);
  }

  public registerGlobalCancelHook(hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>): void {
    this.#getManager().registerGlobalCancelHook(hook);
  }

  public registerTaskCancelHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>
  ): void {
    this.#getManager().registerTaskCancelHook(taskId, hook);
  }

  public getTaskCancelHook(taskId: string): AnyOnCancelHookFunction | undefined {
    return this.#getManager().getTaskCancelHook(taskId);
  }

  public getGlobalCancelHooks(): RegisteredHookFunction<AnyOnCancelHookFunction>[] {
    return this.#getManager().getGlobalCancelHooks();
  }

  public callOnCancelHookListeners(): Promise<void> {
    return this.#getManager().callOnCancelHookListeners();
  }

  public registerOnCancelHookListener(listener: () => Promise<void>): void {
    this.#getManager().registerOnCancelHookListener(listener);
  }

  #getManager(): LifecycleHooksManager {
    return getGlobal(API_NAME) ?? NOOP_LIFECYCLE_HOOKS_MANAGER;
  }
}
