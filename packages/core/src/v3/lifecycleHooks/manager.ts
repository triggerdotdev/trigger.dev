import {
  AnyOnInitHookFunction,
  LifecycleHooksManager,
  RegisteredHookFunction,
  RegisterHookFunctionParams,
} from "./types.js";

export class StandardLifecycleHooksManager implements LifecycleHooksManager {
  private globalInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();
  private taskInitHooks: Map<string, RegisteredHookFunction<AnyOnInitHookFunction>> = new Map();

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
}

function generateHookId(hook: RegisterHookFunctionParams<any>): string {
  return hook.id ?? hook.fn.name
    ? hook.fn.name === ""
      ? hook.fn.toString()
      : hook.fn.name
    : hook.fn.toString();
}
