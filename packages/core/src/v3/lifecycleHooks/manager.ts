import {
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  LifecycleHooksManager,
  RegisteredHookFunction,
  RegisterHookFunctionParams,
  AnyOnFailureHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnCompleteHookFunction,
  AnyOnWaitHookFunction,
  AnyOnResumeHookFunction,
  AnyOnCatchErrorHookFunction,
  AnyOnMiddlewareHookFunction,
  AnyOnCleanupHookFunction,
  TaskWait,
  AnyOnCancelHookFunction,
} from "./types.js";

export class StandardLifecycleHooksManager implements LifecycleHooksManager {
  private globalInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();
  private taskInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();

  private globalStartHooks: Map<string, RegisteredHookFunction<AnyOnStartHookFunction>> = new Map();
  private taskStartHooks: Map<string, RegisteredHookFunction<AnyOnStartHookFunction>> = new Map();

  private globalFailureHooks: Map<string, RegisteredHookFunction<AnyOnFailureHookFunction>> =
    new Map();
  private taskFailureHooks: Map<string, RegisteredHookFunction<AnyOnFailureHookFunction>> =
    new Map();

  private globalSuccessHooks: Map<string, RegisteredHookFunction<AnyOnSuccessHookFunction>> =
    new Map();
  private taskSuccessHooks: Map<string, RegisteredHookFunction<AnyOnSuccessHookFunction>> =
    new Map();

  private globalCompleteHooks: Map<string, RegisteredHookFunction<AnyOnCompleteHookFunction>> =
    new Map();
  private taskCompleteHooks: Map<string, RegisteredHookFunction<AnyOnCompleteHookFunction>> =
    new Map();

  private globalResumeHooks: Map<string, RegisteredHookFunction<AnyOnResumeHookFunction>> =
    new Map();
  private taskResumeHooks: Map<string, RegisteredHookFunction<AnyOnResumeHookFunction>> = new Map();

  private globalCatchErrorHooks: Map<string, RegisteredHookFunction<AnyOnCatchErrorHookFunction>> =
    new Map();
  private taskCatchErrorHooks: Map<string, RegisteredHookFunction<AnyOnCatchErrorHookFunction>> =
    new Map();

  private globalMiddlewareHooks: Map<string, RegisteredHookFunction<AnyOnMiddlewareHookFunction>> =
    new Map();
  private taskMiddlewareHooks: Map<string, RegisteredHookFunction<AnyOnMiddlewareHookFunction>> =
    new Map();

  private globalCleanupHooks: Map<string, RegisteredHookFunction<AnyOnCleanupHookFunction>> =
    new Map();
  private taskCleanupHooks: Map<string, RegisteredHookFunction<AnyOnCleanupHookFunction>> =
    new Map();

  private globalWaitHooks: Map<string, RegisteredHookFunction<AnyOnWaitHookFunction>> = new Map();
  private taskWaitHooks: Map<string, RegisteredHookFunction<AnyOnWaitHookFunction>> = new Map();
  private onWaitHookListeners: ((wait: TaskWait) => Promise<void>)[] = [];

  private onResumeHookListeners: ((wait: TaskWait) => Promise<void>)[] = [];

  private globalCancelHooks: Map<string, RegisteredHookFunction<AnyOnCancelHookFunction>> =
    new Map();
  private taskCancelHooks: Map<string, RegisteredHookFunction<AnyOnCancelHookFunction>> = new Map();
  private onCancelHookListeners: (() => Promise<void>)[] = [];

  reset(): void {
    this.taskInitHooks.clear();
    this.taskStartHooks.clear();
    this.taskFailureHooks.clear();
    this.taskSuccessHooks.clear();
    this.taskCompleteHooks.clear();
    this.taskResumeHooks.clear();
    this.taskCatchErrorHooks.clear();
    this.taskMiddlewareHooks.clear();
    this.taskCleanupHooks.clear();
    this.taskWaitHooks.clear();
    this.taskCancelHooks.clear();
    this.onCancelHookListeners = [];
    this.onWaitHookListeners = [];
    this.onResumeHookListeners = [];
  }

  registerOnCancelHookListener(listener: () => Promise<void>): void {
    this.onCancelHookListeners.push(listener);
  }

  async callOnCancelHookListeners(): Promise<void> {
    await Promise.allSettled(this.onCancelHookListeners.map((listener) => listener()));
  }

  registerOnWaitHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    this.onWaitHookListeners.push(listener);
  }

  async callOnWaitHookListeners(wait: TaskWait): Promise<void> {
    await Promise.allSettled(this.onWaitHookListeners.map((listener) => listener(wait)));
  }

  registerOnResumeHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    this.onResumeHookListeners.push(listener);
  }

  async callOnResumeHookListeners(wait: TaskWait): Promise<void> {
    await Promise.allSettled(this.onResumeHookListeners.map((listener) => listener(wait)));
  }

  registerGlobalStartHook(hook: RegisterHookFunctionParams<AnyOnStartHookFunction>): void {
    const id = generateHookId(hook);

    this.globalStartHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskStartHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnStartHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskStartHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskStartHook(taskId: string): AnyOnStartHookFunction | undefined {
    return this.taskStartHooks.get(taskId)?.fn;
  }

  getGlobalStartHooks(): RegisteredHookFunction<AnyOnStartHookFunction>[] {
    return Array.from(this.globalStartHooks.values());
  }

  registerGlobalInitHook(hook: RegisterHookFunctionParams<AnyOnInitHookFunction>): void {
    // if there is no id, lets generate one based on the contents of the function
    const id = generateHookId(hook);

    const registeredHook = {
      id,
      name: hook.id,
      fn: hook.fn,
    };

    this.globalInitHooks.set(id, registeredHook);
  }

  registerTaskInitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnInitHookFunction>
  ): void {
    const registeredHook = {
      id: generateHookId(hook),
      name: taskId,
      fn: hook.fn,
    };

    this.taskInitHooks.set(taskId, registeredHook);
  }

  getTaskInitHook(taskId: string): AnyOnInitHookFunction | undefined {
    return this.taskInitHooks.get(taskId)?.fn;
  }

  getGlobalInitHooks(): RegisteredHookFunction<AnyOnInitHookFunction>[] {
    return Array.from(this.globalInitHooks.values());
  }

  registerGlobalFailureHook(hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>): void {
    const id = generateHookId(hook);

    this.globalFailureHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskFailureHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskFailureHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskFailureHook(taskId: string): AnyOnFailureHookFunction | undefined {
    return this.taskFailureHooks.get(taskId)?.fn;
  }

  getGlobalFailureHooks(): RegisteredHookFunction<AnyOnFailureHookFunction>[] {
    return Array.from(this.globalFailureHooks.values());
  }

  registerGlobalSuccessHook(hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>): void {
    const id = generateHookId(hook);

    this.globalSuccessHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskSuccessHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskSuccessHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskSuccessHook(taskId: string): AnyOnSuccessHookFunction | undefined {
    return this.taskSuccessHooks.get(taskId)?.fn;
  }

  getGlobalSuccessHooks(): RegisteredHookFunction<AnyOnSuccessHookFunction>[] {
    return Array.from(this.globalSuccessHooks.values());
  }

  registerGlobalCompleteHook(hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>): void {
    const id = generateHookId(hook);

    this.globalCompleteHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskCompleteHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskCompleteHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskCompleteHook(taskId: string): AnyOnCompleteHookFunction | undefined {
    return this.taskCompleteHooks.get(taskId)?.fn;
  }

  getGlobalCompleteHooks(): RegisteredHookFunction<AnyOnCompleteHookFunction>[] {
    return Array.from(this.globalCompleteHooks.values());
  }

  registerGlobalWaitHook(hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>): void {
    const id = generateHookId(hook);

    this.globalWaitHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskWaitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskWaitHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskWaitHook(taskId: string): AnyOnWaitHookFunction | undefined {
    return this.taskWaitHooks.get(taskId)?.fn;
  }

  getGlobalWaitHooks(): RegisteredHookFunction<AnyOnWaitHookFunction>[] {
    return Array.from(this.globalWaitHooks.values());
  }

  registerGlobalResumeHook(hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>): void {
    const id = generateHookId(hook);

    this.globalResumeHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskResumeHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskResumeHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskResumeHook(taskId: string): AnyOnResumeHookFunction | undefined {
    return this.taskResumeHooks.get(taskId)?.fn;
  }

  getGlobalResumeHooks(): RegisteredHookFunction<AnyOnResumeHookFunction>[] {
    return Array.from(this.globalResumeHooks.values());
  }

  registerGlobalCatchErrorHook(
    hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.globalCatchErrorHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskCatchErrorHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskCatchErrorHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskCatchErrorHook(taskId: string): AnyOnCatchErrorHookFunction | undefined {
    return this.taskCatchErrorHooks.get(taskId)?.fn;
  }

  getGlobalCatchErrorHooks(): RegisteredHookFunction<AnyOnCatchErrorHookFunction>[] {
    return Array.from(this.globalCatchErrorHooks.values());
  }

  registerGlobalMiddlewareHook(
    hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.globalMiddlewareHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskMiddlewareHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskMiddlewareHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskMiddlewareHook(taskId: string): AnyOnMiddlewareHookFunction | undefined {
    return this.taskMiddlewareHooks.get(taskId)?.fn;
  }

  getGlobalMiddlewareHooks(): RegisteredHookFunction<AnyOnMiddlewareHookFunction>[] {
    return Array.from(this.globalMiddlewareHooks.values());
  }

  registerGlobalCleanupHook(hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>): void {
    const id = generateHookId(hook);

    this.globalCleanupHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskCleanupHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskCleanupHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getTaskCleanupHook(taskId: string): AnyOnCleanupHookFunction | undefined {
    return this.taskCleanupHooks.get(taskId)?.fn;
  }

  getGlobalCleanupHooks(): RegisteredHookFunction<AnyOnCleanupHookFunction>[] {
    return Array.from(this.globalCleanupHooks.values());
  }

  registerGlobalCancelHook(hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>): void {
    const id = generateHookId(hook);

    this.globalCancelHooks.set(id, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  registerTaskCancelHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>
  ): void {
    const id = generateHookId(hook);

    this.taskCancelHooks.set(taskId, {
      id,
      name: hook.id,
      fn: hook.fn,
    });
  }

  getGlobalCancelHooks(): RegisteredHookFunction<AnyOnCancelHookFunction>[] {
    return Array.from(this.globalCancelHooks.values());
  }

  getTaskCancelHook(taskId: string): AnyOnCancelHookFunction | undefined {
    return this.taskCancelHooks.get(taskId)?.fn;
  }
}

export class NoopLifecycleHooksManager implements LifecycleHooksManager {
  registerOnCancelHookListener(listener: () => Promise<void>): void {
    // Noop
  }

  async callOnCancelHookListeners(): Promise<void> {
    // Noop
  }

  registerGlobalCancelHook(hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>): void {}

  registerTaskCancelHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>
  ): void {
    // Noop
  }

  getTaskCancelHook(taskId: string): AnyOnCancelHookFunction | undefined {
    return undefined;
  }

  getGlobalCancelHooks(): RegisteredHookFunction<AnyOnCancelHookFunction>[] {
    return [];
  }

  registerOnWaitHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    // Noop
  }

  async callOnWaitHookListeners(wait: TaskWait): Promise<void> {
    // Noop
  }

  registerOnResumeHookListener(listener: (wait: TaskWait) => Promise<void>): void {
    // Noop
  }

  async callOnResumeHookListeners(wait: TaskWait): Promise<void> {
    // Noop
  }

  registerGlobalInitHook(hook: RegisterHookFunctionParams<AnyOnInitHookFunction>): void {
    // Noop
  }

  registerTaskInitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnInitHookFunction>
  ): void {
    // Noop
  }

  getTaskInitHook(taskId: string): AnyOnInitHookFunction | undefined {
    return undefined;
  }

  getGlobalInitHooks(): RegisteredHookFunction<AnyOnInitHookFunction>[] {
    return [];
  }

  registerGlobalStartHook(hook: RegisterHookFunctionParams<AnyOnStartHookFunction>): void {
    // Noop
  }

  registerTaskStartHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnStartHookFunction>
  ): void {
    // Noop
  }

  getTaskStartHook(taskId: string): AnyOnStartHookFunction | undefined {
    return undefined;
  }

  getGlobalStartHooks(): RegisteredHookFunction<AnyOnStartHookFunction>[] {
    return [];
  }

  registerGlobalFailureHook(hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>): void {
    // Noop
  }

  registerTaskFailureHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>
  ): void {
    // Noop
  }

  getTaskFailureHook(taskId: string): AnyOnFailureHookFunction | undefined {
    return undefined;
  }

  getGlobalFailureHooks(): RegisteredHookFunction<AnyOnFailureHookFunction>[] {
    return [];
  }

  registerGlobalSuccessHook(hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>): void {
    // Noop
  }

  registerTaskSuccessHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>
  ): void {
    // Noop
  }

  getTaskSuccessHook(taskId: string): AnyOnSuccessHookFunction | undefined {
    return undefined;
  }

  getGlobalSuccessHooks(): RegisteredHookFunction<AnyOnSuccessHookFunction>[] {
    return [];
  }

  registerGlobalCompleteHook(hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>): void {
    // Noop
  }

  registerTaskCompleteHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>
  ): void {
    // Noop
  }

  getTaskCompleteHook(taskId: string): AnyOnCompleteHookFunction | undefined {
    return undefined;
  }

  getGlobalCompleteHooks(): RegisteredHookFunction<AnyOnCompleteHookFunction>[] {
    return [];
  }

  registerGlobalWaitHook(hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>): void {
    // Noop
  }

  registerTaskWaitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>
  ): void {
    // Noop
  }

  getTaskWaitHook(taskId: string): AnyOnWaitHookFunction | undefined {
    return undefined;
  }

  getGlobalWaitHooks(): RegisteredHookFunction<AnyOnWaitHookFunction>[] {
    return [];
  }

  registerGlobalResumeHook(hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>): void {
    // Noop
  }

  registerTaskResumeHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>
  ): void {
    // Noop
  }

  getTaskResumeHook(taskId: string): AnyOnResumeHookFunction | undefined {
    return undefined;
  }

  getGlobalResumeHooks(): RegisteredHookFunction<AnyOnResumeHookFunction>[] {
    return [];
  }

  registerGlobalCatchErrorHook(): void {
    // Noop
  }

  registerTaskCatchErrorHook(): void {
    // Noop
  }

  getTaskCatchErrorHook(): undefined {
    return undefined;
  }

  getGlobalCatchErrorHooks(): [] {
    return [];
  }

  registerGlobalMiddlewareHook(): void {
    // Noop
  }

  registerTaskMiddlewareHook(): void {
    // Noop
  }

  getTaskMiddlewareHook(): undefined {
    return undefined;
  }

  getGlobalMiddlewareHooks(): [] {
    return [];
  }

  registerGlobalCleanupHook(hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>): void {
    // Noop
  }

  registerTaskCleanupHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>
  ): void {
    // Noop
  }

  getTaskCleanupHook(taskId: string): AnyOnCleanupHookFunction | undefined {
    return undefined;
  }

  getGlobalCleanupHooks(): RegisteredHookFunction<AnyOnCleanupHookFunction>[] {
    return [];
  }
}

function generateHookId(hook: RegisterHookFunctionParams<any>): string {
  return hook.id ?? hook.fn.toString();
}
