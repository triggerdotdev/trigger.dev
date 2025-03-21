import {
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  LifecycleHooksManager,
  RegisteredHookFunction,
  RegisterHookFunctionParams,
} from "./types.js";

export class StandardLifecycleHooksManager implements LifecycleHooksManager {
  private globalInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();
  private taskInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();

  private globalStartHooks: Map<string, RegisteredHookFunction<AnyOnStartHookFunction>> = new Map();
  private taskStartHooks: Map<string, RegisteredHookFunction<AnyOnStartHookFunction>> = new Map();

  registerGlobalStartHook(hook: RegisterHookFunctionParams<AnyOnStartHookFunction>): void {
    const id = generateHookId(hook);

    this.globalStartHooks.set(id, {
      id,
      name: hook.id ?? hook.fn.name ? (hook.fn.name === "" ? undefined : hook.fn.name) : undefined,
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
      name: hook.id ?? hook.fn.name ? (hook.fn.name === "" ? undefined : hook.fn.name) : undefined,
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
      name: hook.id ?? hook.fn.name ? (hook.fn.name === "" ? undefined : hook.fn.name) : undefined,
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
}

export class NoopLifecycleHooksManager implements LifecycleHooksManager {
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
}

function generateHookId(hook: RegisterHookFunctionParams<any>): string {
  return hook.id ?? hook.fn.name
    ? hook.fn.name === ""
      ? hook.fn.toString()
      : hook.fn.name
    : hook.fn.toString();
}
