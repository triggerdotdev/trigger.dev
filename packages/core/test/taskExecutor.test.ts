import { describe, expect, test } from "vitest";
import { ApiError } from "../src/v3/apiClient/errors.js";
import { ConsoleInterceptor } from "../src/v3/consoleInterceptor.js";
import {
  lifecycleHooks,
  RetryOptions,
  RunFnParams,
  ServerBackgroundWorker,
  TaskMetadataWithFunctions,
  TaskRunErrorCodes,
  TaskRunExecution,
} from "../src/v3/index.js";
import { StandardLifecycleHooksManager } from "../src/v3/lifecycleHooks/manager.js";
import { TracingSDK } from "../src/v3/otel/tracingSDK.js";
import { TriggerTracer } from "../src/v3/tracer.js";
import { TaskExecutor } from "../src/v3/workers/taskExecutor.js";

describe("TaskExecutor", () => {
  beforeEach(() => {
    lifecycleHooks.setGlobalLifecycleHooksManager(new StandardLifecycleHooksManager());
  });

  afterEach(() => {
    lifecycleHooks.disable();
  });

  test("should call onComplete with success result", async () => {
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    lifecycleHooks.registerTaskInitHook("test-task", {
      id: "test-init",
      fn: async () => {
        return {
          bar: "baz",
        };
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, {}, undefined);

    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar","bar":"baz"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call onSuccess hooks in correct order with proper data", async () => {
    const globalSuccessOrder: string[] = [];
    const successPayloads: any[] = [];
    const successOutputs: any[] = [];
    const successInits: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register two global success hooks
    lifecycleHooks.registerGlobalSuccessHook({
      id: "global-success-2", // Register second hook first
      fn: async ({ payload, output, init }) => {
        console.log("Executing global success hook 2");
        globalSuccessOrder.push("global-2");
        successPayloads.push(payload);
        successOutputs.push(output);
        successInits.push(init);
      },
    });

    lifecycleHooks.registerGlobalSuccessHook({
      id: "global-success-1", // Register first hook second
      fn: async ({ payload, output, init }) => {
        console.log("Executing global success hook 1");
        globalSuccessOrder.push("global-1");
        successPayloads.push(payload);
        successOutputs.push(output);
        successInits.push(init);
      },
    });

    // Register task-specific success hook
    lifecycleHooks.registerTaskSuccessHook("test-task", {
      id: "task-success",
      fn: async ({ payload, output, init }) => {
        console.log("Executing task success hook");
        globalSuccessOrder.push("task");
        successPayloads.push(payload);
        successOutputs.push(output);
        successInits.push(init);
      },
    });

    // Verify hooks are registered
    const globalHooks = lifecycleHooks.getGlobalSuccessHooks();
    console.log(
      "Registered global hooks:",
      globalHooks.map((h) => h.id)
    );
    const taskHook = lifecycleHooks.getTaskSuccessHook("test-task");
    console.log("Registered task hook:", taskHook ? "yes" : "no");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, {}, undefined);

    // Verify hooks were called in correct order - should match registration order
    expect(globalSuccessOrder).toEqual(["global-2", "global-1", "task"]);

    // Verify each hook received the correct payload
    successPayloads.forEach((payload) => {
      expect(payload).toEqual({});
    });

    // Verify each hook received the correct output
    successOutputs.forEach((output) => {
      expect(output).toEqual({
        output: "test-output",
        init: { foo: "bar" },
      });
    });

    // Verify each hook received the correct init data
    successInits.forEach((init) => {
      expect(init).toEqual({ foo: "bar" });
    });

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call onStart hooks in correct order with proper data", async () => {
    const globalStartOrder: string[] = [];
    const startPayloads: any[] = [];
    const startInits: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register two global start hooks
    lifecycleHooks.registerGlobalStartHook({
      id: "global-start-1",
      fn: async ({ payload, ctx, init }) => {
        console.log("Executing global start hook 1");
        globalStartOrder.push("global-1");
        startPayloads.push(payload);
        startInits.push(init);
      },
    });

    lifecycleHooks.registerGlobalStartHook({
      id: "global-start-2",
      fn: async ({ payload, ctx, init }) => {
        console.log("Executing global start hook 2");
        globalStartOrder.push("global-2");
        startPayloads.push(payload);
        startInits.push(init);
      },
    });

    // Register task-specific start hook
    lifecycleHooks.registerTaskStartHook("test-task", {
      id: "task-start",
      fn: async ({ payload, ctx, init }) => {
        console.log("Executing task start hook");
        globalStartOrder.push("task");
        startPayloads.push(payload);
        startInits.push(init);
      },
    });

    // Verify hooks are registered
    const globalHooks = lifecycleHooks.getGlobalStartHooks();
    console.log(
      "Registered global hooks:",
      globalHooks.map((h) => h.id)
    );
    const taskHook = lifecycleHooks.getTaskStartHook("test-task");
    console.log("Registered task hook:", taskHook ? "yes" : "no");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order
    expect(globalStartOrder).toEqual(["global-1", "global-2", "task"]);

    // Verify each hook received the correct payload
    startPayloads.forEach((payload) => {
      expect(payload).toEqual({ test: "data" });
    });

    console.log("startInits", startInits);

    // Verify each hook received the correct init data
    startInits.forEach((init) => {
      expect(init).toEqual({ foo: "bar" });
    });

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call onStartAttempt hooks in correct order with proper data", async () => {
    const globalStartOrder: string[] = [];
    const startPayloads: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register two global start hooks
    lifecycleHooks.registerGlobalStartAttemptHook({
      id: "global-start-1",
      fn: async ({ payload, ctx }) => {
        console.log("Executing global start hook 1");
        globalStartOrder.push("global-1");
        startPayloads.push(payload);
      },
    });

    lifecycleHooks.registerGlobalStartAttemptHook({
      id: "global-start-2",
      fn: async ({ payload, ctx }) => {
        console.log("Executing global start hook 2");
        globalStartOrder.push("global-2");
        startPayloads.push(payload);
      },
    });

    // Register task-specific start hook
    lifecycleHooks.registerTaskStartAttemptHook("test-task", {
      id: "task-start",
      fn: async ({ payload, ctx }) => {
        console.log("Executing task start hook");
        globalStartOrder.push("task");
        startPayloads.push(payload);
      },
    });

    // Verify hooks are registered
    const globalHooks = lifecycleHooks.getGlobalStartAttemptHooks();
    console.log(
      "Registered global hooks:",
      globalHooks.map((h) => h.id)
    );
    const taskHook = lifecycleHooks.getTaskStartAttemptHook("test-task");
    console.log("Registered task hook:", taskHook ? "yes" : "no");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order
    expect(globalStartOrder).toEqual(["global-1", "global-2", "task"]);

    // Verify each hook received the correct payload
    startPayloads.forEach((payload) => {
      expect(payload).toEqual({ test: "data" });
    });

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call onFailure hooks with error when task fails", async () => {
    const globalFailureOrder: string[] = [];
    const failurePayloads: any[] = [];
    const failureErrors: any[] = [];
    const failureInits: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register two global failure hooks
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure-1",
      fn: async ({ payload, error, init }) => {
        console.log("Executing global failure hook 1");
        globalFailureOrder.push("global-1");
        failurePayloads.push(payload);
        failureErrors.push(error);
        failureInits.push(init);
      },
    });

    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure-2",
      fn: async ({ payload, error, init }) => {
        console.log("Executing global failure hook 2");
        globalFailureOrder.push("global-2");
        failurePayloads.push(payload);
        failureErrors.push(error);
        failureInits.push(init);
      },
    });

    // Register task-specific failure hook
    lifecycleHooks.registerTaskFailureHook("test-task", {
      id: "task-failure",
      fn: async ({ payload, error, init }) => {
        console.log("Executing task failure hook");
        globalFailureOrder.push("task");
        failurePayloads.push(payload);
        failureErrors.push(error);
        failureInits.push(init);
      },
    });

    // Verify hooks are registered
    const globalHooks = lifecycleHooks.getGlobalFailureHooks();
    console.log(
      "Registered global hooks:",
      globalHooks.map((h) => h.id)
    );
    const taskHook = lifecycleHooks.getTaskFailureHook("test-task");
    console.log("Registered task hook:", taskHook ? "yes" : "no");

    const expectedError = new Error("Task failed intentionally");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order
    expect(globalFailureOrder).toEqual(["global-1", "global-2", "task"]);

    // Verify each hook received the correct payload
    failurePayloads.forEach((payload) => {
      expect(payload).toEqual({ test: "data" });
    });

    // Verify each hook received the correct error
    failureErrors.forEach((error) => {
      expect(error).toBe(expectedError);
    });

    // Verify each hook received the correct init data
    failureInits.forEach((init) => {
      expect(init).toEqual({ foo: "bar" });
    });

    // Verify the final result contains the error
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should call onComplete hooks in correct order with proper data", async () => {
    const globalCompleteOrder: string[] = [];
    const completePayloads: any[] = [];
    const completeResults: any[] = [];
    const completeInits: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register two global complete hooks
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete-1",
      fn: async ({ payload, result, init }) => {
        console.log("Executing global complete hook 1");
        globalCompleteOrder.push("global-1");
        completePayloads.push(payload);
        completeResults.push(result);
        completeInits.push(init);
      },
    });

    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete-2",
      fn: async ({ payload, result, init }) => {
        console.log("Executing global complete hook 2");
        globalCompleteOrder.push("global-2");
        completePayloads.push(payload);
        completeResults.push(result);
        completeInits.push(init);
      },
    });

    // Register task-specific complete hook
    lifecycleHooks.registerTaskCompleteHook("test-task", {
      id: "task-complete",
      fn: async ({ payload, result, init }) => {
        console.log("Executing task complete hook");
        globalCompleteOrder.push("task");
        completePayloads.push(payload);
        completeResults.push(result);
        completeInits.push(init);
      },
    });

    // Verify hooks are registered
    const globalHooks = lifecycleHooks.getGlobalCompleteHooks();
    console.log(
      "Registered global hooks:",
      globalHooks.map((h) => h.id)
    );
    const taskHook = lifecycleHooks.getTaskCompleteHook("test-task");
    console.log("Registered task hook:", taskHook ? "yes" : "no");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order
    expect(globalCompleteOrder).toEqual(["global-1", "global-2", "task"]);

    // Verify each hook received the correct payload
    completePayloads.forEach((payload) => {
      expect(payload).toEqual({ test: "data" });
    });

    // Verify each hook received the correct result
    completeResults.forEach((result) => {
      expect(result).toEqual({
        ok: true,
        data: {
          output: "test-output",
          init: { foo: "bar" },
        },
      });
    });

    // Verify each hook received the correct init data
    completeInits.forEach((init) => {
      expect(init).toEqual({ foo: "bar" });
    });

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call onComplete hooks with error when task fails", async () => {
    const globalCompleteOrder: string[] = [];
    const completePayloads: any[] = [];
    const completeResults: any[] = [];
    const completeInits: any[] = [];

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register global complete hooks
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ payload, result, init }) => {
        console.log("Executing global complete hook");
        globalCompleteOrder.push("global");
        completePayloads.push(payload);
        completeResults.push(result);
        completeInits.push(init);
      },
    });

    // Register task-specific complete hook
    lifecycleHooks.registerTaskCompleteHook("test-task", {
      id: "task-complete",
      fn: async ({ payload, result, init }) => {
        console.log("Executing task complete hook");
        globalCompleteOrder.push("task");
        completePayloads.push(payload);
        completeResults.push(result);
        completeInits.push(init);
      },
    });

    const expectedError = new Error("Task failed intentionally");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order
    expect(globalCompleteOrder).toEqual(["global", "task"]);

    // Verify each hook received the correct payload
    completePayloads.forEach((payload) => {
      expect(payload).toEqual({ test: "data" });
    });

    // Verify each hook received the error result
    completeResults.forEach((result) => {
      expect(result).toEqual({
        ok: false,
        error: expectedError,
      });
    });

    // Verify each hook received the correct init data
    completeInits.forEach((init) => {
      expect(init).toEqual({ foo: "bar" });
    });

    // Verify the final result contains the error
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should call catchError hooks in correct order and stop at first handler that returns a result", async () => {
    const hookCallOrder: string[] = [];
    const expectedError = new Error("Task failed intentionally");

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Register task-specific catch error hook that doesn't handle the error
    lifecycleHooks.registerTaskCatchErrorHook("test-task", {
      id: "task-catch-error",
      fn: async ({ payload, error, init, retry }) => {
        console.log("Executing task catch error hook");
        hookCallOrder.push("task");
        // Return undefined to let it fall through to global handlers
        return undefined;
      },
    });

    // Register first global catch error hook that doesn't handle the error
    lifecycleHooks.registerGlobalCatchErrorHook({
      id: "global-catch-error-1",
      fn: async ({ payload, error, init, retry }) => {
        console.log("Executing global catch error hook 1");
        hookCallOrder.push("global-1");
        // Return undefined to let it fall through to next handler
        return undefined;
      },
    });

    // Register second global catch error hook that handles the error
    lifecycleHooks.registerGlobalCatchErrorHook({
      id: "global-catch-error-2",
      fn: async ({ payload, error, init, retry }) => {
        console.log("Executing global catch error hook 2");
        hookCallOrder.push("global-2");
        // Return a result to handle the error
        return {
          retry: {
            maxAttempts: 3,
            minDelay: 1000,
            maxDelay: 5000,
            factor: 2,
          },
        };
      },
    });

    // Register third global catch error hook that should never be called
    lifecycleHooks.registerGlobalCatchErrorHook({
      id: "global-catch-error-3",
      fn: async ({ payload, error, init, retry }) => {
        console.log("Executing global catch error hook 3");
        hookCallOrder.push("global-3");
        return undefined;
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify hooks were called in correct order and stopped after second global hook
    expect(hookCallOrder).toEqual(["task", "global-1", "global-2"]);
    // global-3 should not be called since global-2 returned a result

    // Verify the final result contains retry information from the second global hook
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        retry: {
          timestamp: expect.any(Number),
          delay: expect.any(Number),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should skip retrying if catch error hook returns skipRetrying", async () => {
    const hookCallOrder: string[] = [];
    const expectedError = new Error("Task failed intentionally");

    // Register task-specific catch error hook that handles the error
    lifecycleHooks.registerTaskCatchErrorHook("test-task", {
      id: "task-catch-error",
      fn: async ({ payload, error, init }) => {
        console.log("Executing task catch error hook");
        hookCallOrder.push("task");
        return {
          skipRetrying: true,
          error: new Error("Modified error in catch hook"),
        };
      },
    });

    // Register global catch error hook that should never be called
    lifecycleHooks.registerGlobalCatchErrorHook({
      id: "global-catch-error",
      fn: async ({ payload, error, init }) => {
        console.log("Executing global catch error hook");
        hookCallOrder.push("global");
        return undefined;
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify only task hook was called
    expect(hookCallOrder).toEqual(["task"]);

    // Verify the final result shows skipped retrying and the modified error
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Modified error in catch hook",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: true,
      },
    });
  });

  test("should use specific retry timing if catch error hook provides it", async () => {
    const hookCallOrder: string[] = [];
    const expectedError = new Error("Task failed intentionally");
    const specificRetryDate = new Date(Date.now() + 30000); // 30 seconds in future

    // Register task-specific catch error hook that specifies retry timing
    lifecycleHooks.registerTaskCatchErrorHook("test-task", {
      id: "task-catch-error",
      fn: async ({ payload, error, init }) => {
        console.log("Executing task catch error hook");
        hookCallOrder.push("task");
        return {
          retryAt: specificRetryDate,
          error: expectedError,
        };
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify only task hook was called
    expect(hookCallOrder).toEqual(["task"]);

    // Verify the final result contains the specific retry timing
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        retry: {
          timestamp: specificRetryDate.getTime(),
          delay: expect.any(Number),
        },
        skippedRetrying: false,
      },
    });

    expect((result as any).result.retry.delay).toBeGreaterThan(29900);
    expect((result as any).result.retry.delay).toBeLessThan(30100);
  });

  test("should use the default retry settings if no catch error hook is provided", async () => {
    const expectedError = new Error("Task failed intentionally");

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined, {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 5000,
      factor: 2,
    });

    // Verify the final result contains the specific retry timing
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        retry: {
          timestamp: expect.any(Number),
          delay: expect.any(Number),
        },
        skippedRetrying: false,
      },
    });

    expect((result as any).result.retry.delay).toBeGreaterThan(1000);
    expect((result as any).result.retry.delay).toBeLessThan(3000);
  });

  test("should execute middleware hooks in correct order around other hooks", async () => {
    const executionOrder: string[] = [];

    // Register global init hook
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        executionOrder.push("init");
        return {
          foo: "bar",
        };
      },
    });

    // Register global start hook
    lifecycleHooks.registerGlobalStartHook({
      id: "global-start",
      fn: async ({ payload }) => {
        executionOrder.push("start");
      },
    });

    // Register global success hook
    lifecycleHooks.registerGlobalSuccessHook({
      id: "global-success",
      fn: async ({ payload, output }) => {
        executionOrder.push("success");
      },
    });

    // Register global complete hook
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ payload, result }) => {
        executionOrder.push("complete");
      },
    });

    // Register task-specific middleware that executes first
    lifecycleHooks.registerTaskMiddlewareHook("test-task", {
      id: "task-middleware",
      fn: async ({ payload, ctx, next }) => {
        executionOrder.push("task-middleware-before");
        await next();
        executionOrder.push("task-middleware-after");
      },
    });

    // Register two global middleware hooks
    lifecycleHooks.registerGlobalMiddlewareHook({
      id: "global-middleware-1",
      fn: async ({ payload, ctx, next }) => {
        executionOrder.push("global-middleware-1-before");
        await next();
        executionOrder.push("global-middleware-1-after");
      },
    });

    lifecycleHooks.registerGlobalMiddlewareHook({
      id: "global-middleware-2",
      fn: async ({ payload, ctx, next }) => {
        executionOrder.push("global-middleware-2-before");
        await next();
        executionOrder.push("global-middleware-2-after");
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify the execution order:
    // 1. Global middlewares (outside to inside)
    // 2. Task middleware
    // 3. Init hook
    // 4. Start hook
    // 5. Run function
    // 6. Success hook
    // 7. Complete hook
    // 8. Middlewares in reverse order
    expect(executionOrder).toEqual([
      "global-middleware-1-before",
      "global-middleware-2-before",
      "task-middleware-before",
      "init",
      "start",
      "run",
      "success",
      "complete",
      "task-middleware-after",
      "global-middleware-2-after",
      "global-middleware-1-after",
    ]);

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should handle middleware errors correctly", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("Middleware error");

    // Register global middleware that throws an error
    lifecycleHooks.registerGlobalMiddlewareHook({
      id: "global-middleware",
      fn: async ({ payload, ctx, next }) => {
        executionOrder.push("middleware-before");
        throw expectedError;
        // Should never get here
        await next();
        executionOrder.push("middleware-after");
      },
    });

    // Register failure hook to verify it's called
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async ({ payload, error }) => {
        executionOrder.push("failure");
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify only the middleware-before hook ran
    expect(executionOrder).toEqual(["middleware-before"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "INTERNAL_ERROR",
          message: "Error: Middleware error",
          code: "TASK_MIDDLEWARE_ERROR",
          stackTrace: expect.any(String),
        },
      },
    });
  });

  test("should propagate errors from init hooks", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("Init hook error");

    // Register global init hook that throws an error
    lifecycleHooks.registerGlobalInitHook({
      id: "failing-init",
      fn: async () => {
        executionOrder.push("global-init");
        throw expectedError;
      },
    });

    // Register task init hook that should never be called
    lifecycleHooks.registerTaskInitHook("test-task", {
      id: "task-init",
      fn: async () => {
        executionOrder.push("task-init");
        return {
          foo: "bar",
        };
      },
    });

    // Register failure hook to verify it's called
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async ({ error }) => {
        executionOrder.push("failure");
        expect(error).toBe(expectedError);
      },
    });

    // Register complete hook to verify it's called with error
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ result }) => {
        executionOrder.push("complete");
        expect(result).toEqual({
          ok: false,
          error: expectedError,
        });
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify only the global init hook ran, and failure/complete hooks were called
    expect(executionOrder).toEqual(["global-init", "failure", "complete"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Init hook error",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should propagate errors from task init hooks", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("Task init hook error");

    // Register global init hook that succeeds
    lifecycleHooks.registerGlobalInitHook({
      id: "global-init",
      fn: async () => {
        executionOrder.push("global-init");
        return {
          foo: "bar",
        };
      },
    });

    // Register task init hook that throws an error
    lifecycleHooks.registerTaskInitHook("test-task", {
      id: "task-init",
      fn: async () => {
        executionOrder.push("task-init");
        throw expectedError;
      },
    });

    // Register failure hook to verify it's called
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async ({ error, init }) => {
        executionOrder.push("failure");
        expect(error).toBe(expectedError);
      },
    });

    // Register complete hook to verify it's called with error
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ result, init }) => {
        executionOrder.push("complete");
        expect(result).toEqual({
          ok: false,
          error: expectedError,
        });
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify both init hooks ran, but run wasn't called, and failure/complete hooks were called
    expect(executionOrder).toEqual(["global-init", "task-init", "failure", "complete"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task init hook error",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should propagate errors from start hooks", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("Start hook error");

    // Register global init hook that succeeds
    lifecycleHooks.registerGlobalInitHook({
      id: "global-init",
      fn: async () => {
        executionOrder.push("global-init");
        return {
          foo: "bar",
        };
      },
    });

    // Register global start hook that throws an error
    lifecycleHooks.registerGlobalStartHook({
      id: "global-start",
      fn: async () => {
        executionOrder.push("global-start");
        throw expectedError;
      },
    });

    // Register task start hook that should never be called
    lifecycleHooks.registerTaskStartHook("test-task", {
      id: "task-start",
      fn: async () => {
        executionOrder.push("task-start");
      },
    });

    // Register failure hook to verify it's called
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async ({ error, init }) => {
        executionOrder.push("failure");
        expect(error).toBe(expectedError);
        // Verify we got the init data
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register complete hook to verify it's called with error
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ result, init }) => {
        executionOrder.push("complete");
        expect(result).toEqual({
          ok: false,
          error: expectedError,
        });
        // Verify we got the init data
        expect(init).toEqual({ foo: "bar" });
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify init succeeded, start hook failed, and run wasn't called
    expect(executionOrder).toEqual(["global-init", "global-start", "failure", "complete"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Start hook error",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should NOT propagate errors from onSuccess hooks", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("On success hook error");

    // Register global on success hook that throws an error
    lifecycleHooks.registerGlobalSuccessHook({
      id: "global-success",
      fn: async () => {
        executionOrder.push("global-success");
        throw expectedError;
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
          };
        },
      },
    };

    // Expect that this does not throw an error
    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify that run was called and on success hook was called
    expect(executionOrder).toEqual(["run", "global-success"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output"}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call cleanup hooks in correct order after other hooks but before middleware completion", async () => {
    const executionOrder: string[] = [];

    // Register global init hook
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        executionOrder.push("init");
        return {
          foo: "bar",
        };
      },
    });

    // Register global start hook
    lifecycleHooks.registerGlobalStartHook({
      id: "global-start",
      fn: async () => {
        executionOrder.push("start");
      },
    });

    // Register global success hook
    lifecycleHooks.registerGlobalSuccessHook({
      id: "global-success",
      fn: async () => {
        executionOrder.push("success");
      },
    });

    // Register global complete hook
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async () => {
        executionOrder.push("complete");
      },
    });

    // Register global cleanup hooks
    lifecycleHooks.registerGlobalCleanupHook({
      id: "global-cleanup-1",
      fn: async ({ init }) => {
        executionOrder.push("global-cleanup-1");
        // Verify we have access to init data
        expect(init).toEqual({ foo: "bar" });
      },
    });

    lifecycleHooks.registerGlobalCleanupHook({
      id: "global-cleanup-2",
      fn: async ({ init }) => {
        executionOrder.push("global-cleanup-2");
        // Verify we have access to init data
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register task-specific cleanup hook
    lifecycleHooks.registerTaskCleanupHook("test-task", {
      id: "task-cleanup",
      fn: async ({ init }) => {
        executionOrder.push("task-cleanup");
        // Verify we have access to init data
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register middleware to verify cleanup happens before middleware completion
    lifecycleHooks.registerGlobalMiddlewareHook({
      id: "global-middleware",
      fn: async ({ next }) => {
        executionOrder.push("middleware-before");
        await next();
        executionOrder.push("middleware-after");
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run");
          return {
            output: "test-output",
            init: params.init,
          };
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify the execution order:
    // 1. Middleware starts
    // 2. Init hook
    // 3. Start hook
    // 4. Run function
    // 5. Success hook
    // 6. Complete hook
    // 7. Cleanup hooks
    // 8. Middleware completes
    expect(executionOrder).toEqual([
      "middleware-before",
      "init",
      "start",
      "run",
      "success",
      "complete",
      "global-cleanup-1",
      "global-cleanup-2",
      "task-cleanup",
      "middleware-after",
    ]);

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"output":"test-output","init":{"foo":"bar"}}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should call cleanup hooks even when task fails", async () => {
    const executionOrder: string[] = [];
    const expectedError = new Error("Task failed intentionally");

    // Register global init hook
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        executionOrder.push("init");
        return {
          foo: "bar",
        };
      },
    });

    // Register failure hook
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async () => {
        executionOrder.push("failure");
      },
    });

    // Register complete hook
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async () => {
        executionOrder.push("complete");
      },
    });

    // Register cleanup hooks
    lifecycleHooks.registerGlobalCleanupHook({
      id: "global-cleanup",
      fn: async ({ init }) => {
        executionOrder.push("global-cleanup");
        // Verify we have access to init data even after failure
        expect(init).toEqual({ foo: "bar" });
      },
    });

    lifecycleHooks.registerTaskCleanupHook("test-task", {
      id: "task-cleanup",
      fn: async ({ init }) => {
        executionOrder.push("task-cleanup");
        // Verify we have access to init data even after failure
        expect(init).toEqual({ foo: "bar" });
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async () => {
          executionOrder.push("run");
          throw expectedError;
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify cleanup hooks are called even after failure
    expect(executionOrder).toEqual([
      "init",
      "run",
      "failure",
      "complete",
      "global-cleanup",
      "task-cleanup",
    ]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "Task failed intentionally",
          name: "Error",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should handle max duration abort signal and call hooks in correct order", async () => {
    const executionOrder: string[] = [];
    const maxDurationSeconds = 1000;

    // Create an abort controller that we'll trigger manually
    const controller = new AbortController();

    // Register global init hook
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        executionOrder.push("init");
        return {
          foo: "bar",
        };
      },
    });

    // Register failure hook
    lifecycleHooks.registerGlobalFailureHook({
      id: "global-failure",
      fn: async ({ error }) => {
        executionOrder.push("failure");
        expect((error as Error).message).toBe(
          `Run exceeded maximum compute time (maxDuration) of ${maxDurationSeconds} seconds`
        );
      },
    });

    // Register complete hook
    lifecycleHooks.registerGlobalCompleteHook({
      id: "global-complete",
      fn: async ({ result }) => {
        executionOrder.push("complete");
        expect(result.ok).toBe(false);
      },
    });

    // Register cleanup hook
    lifecycleHooks.registerGlobalCleanupHook({
      id: "global-cleanup",
      fn: async () => {
        executionOrder.push("cleanup");
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run-start");

          // Create a promise that never resolves
          await new Promise((resolve) => {
            // Trigger abort after a small delay
            setTimeout(() => {
              controller.abort();
            }, 10);
          });

          // This should never be reached
          executionOrder.push("run-end");
        },
      },
    };

    const result = await executeTask(task, { test: "data" }, controller.signal);

    // Verify hooks were called in correct order
    expect(executionOrder).toEqual(["init", "run-start", "failure", "complete", "cleanup"]);

    // Verify the error result
    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.MAX_DURATION_EXCEEDED,
          message: "Run exceeded maximum compute time (maxDuration) of 1000 seconds",
          stackTrace: expect.any(String),
        },
        skippedRetrying: false,
      },
    });
  });

  test("should call onWait and onResume hooks in correct order with proper data", async () => {
    const executionOrder: string[] = [];
    const waitData = { type: "task", runId: "test-run-id" } as const;

    // Register global init hook to provide init data
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        executionOrder.push("init");
        return {
          foo: "bar",
        };
      },
    });

    // Register global wait hooks
    lifecycleHooks.registerGlobalWaitHook({
      id: "global-wait-1",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("global-wait-1");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    lifecycleHooks.registerGlobalWaitHook({
      id: "global-wait-2",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("global-wait-2");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register task-specific wait hook
    lifecycleHooks.registerTaskWaitHook("test-task", {
      id: "task-wait",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("task-wait");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register global resume hooks
    lifecycleHooks.registerGlobalResumeHook({
      id: "global-resume-1",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("global-resume-1");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    lifecycleHooks.registerGlobalResumeHook({
      id: "global-resume-2",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("global-resume-2");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    // Register task-specific resume hook
    lifecycleHooks.registerTaskResumeHook("test-task", {
      id: "task-resume",
      fn: async ({ payload, wait, init }) => {
        executionOrder.push("task-resume");
        expect(wait).toEqual(waitData);
        expect(init).toEqual({ foo: "bar" });
      },
    });

    const task = {
      id: "test-task",
      fns: {
        run: async (payload: any, params: RunFnParams<any>) => {
          executionOrder.push("run-start");

          // Simulate a wait
          await lifecycleHooks.callOnWaitHookListeners(waitData);

          // Simulate some time passing
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Simulate resuming
          await lifecycleHooks.callOnResumeHookListeners(waitData);

          executionOrder.push("run-end");
          return { success: true };
        },
      },
    };

    const result = await executeTask(task, { test: "data" });

    // Verify hooks were called in correct order
    expect(executionOrder).toEqual([
      "init",
      "run-start",
      "global-wait-1",
      "global-wait-2",
      "task-wait",
      "global-resume-1",
      "global-resume-2",
      "task-resume",
      "run-end",
    ]);

    // Verify the final result
    expect(result).toEqual({
      result: {
        ok: true,
        id: "test-run-id",
        output: '{"json":{"success":true}}',
        outputType: "application/super+json",
      },
    });
  });

  test("should skip retrying for unretryable API errors", async () => {
    const unretryableStatusCodes = [400, 401, 403, 404, 422];
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];

    // Register global init hook
    lifecycleHooks.registerGlobalInitHook({
      id: "test-init",
      fn: async () => {
        return {
          foo: "bar",
        };
      },
    });

    // Test each unretryable status code
    for (const status of unretryableStatusCodes) {
      const apiError = ApiError.generate(
        status,
        { error: { message: "API Error" } },
        "API Error",
        {}
      );

      const task = {
        id: "test-task",
        fns: {
          run: async () => {
            throw apiError;
          },
        },
        retry: {
          maxAttempts: 3,
          minDelay: 1000,
          maxDelay: 5000,
          factor: 2,
        },
      };

      const result = await executeTask(task, { test: "data" }, undefined);

      // Verify that retrying is skipped for these status codes
      expect(result.result).toMatchObject({
        ok: false,
        id: "test-run-id",
        error: {
          type: "BUILT_IN_ERROR",
          message: "API Error",
          name: "TriggerApiError",
          stackTrace: expect.any(String),
        },
        skippedRetrying: true,
      });
    }

    // Test each retryable status code
    for (const status of retryableStatusCodes) {
      const apiError = ApiError.generate(
        status,
        { error: { message: "API Error" } },
        "API Error",
        {}
      );

      const task = {
        id: "test-task",
        fns: {
          run: async () => {
            throw apiError;
          },
        },
        retry: {
          maxAttempts: 3,
          minDelay: 1000,
          maxDelay: 5000,
          factor: 2,
        },
      };

      const result = await executeTask(task, { test: "data" }, undefined);

      // Verify that retrying is NOT skipped for these status codes
      expect(result.result.ok).toBe(false);
      expect(result.result).toMatchObject({
        ok: false,
        skippedRetrying: false,
        retry: expect.objectContaining({
          delay: expect.any(Number),
          timestamp: expect.any(Number),
        }),
      });

      if (status === 429) {
        // Rate limit errors should use the rate limit retry delay
        expect((result.result as any).retry.delay).toBeGreaterThan(0);
      } else {
        // Other retryable errors should use the exponential backoff
        expect((result.result as any).retry.delay).toBeGreaterThan(1000);
        expect((result.result as any).retry.delay).toBeLessThan(5000);
      }
    }
  });

  test("should respect rate limit headers for 429 errors", async () => {
    const resetTime = Date.now() + 30000; // 30 seconds from now
    const apiError = ApiError.generate(
      429,
      { error: { message: "Rate limit exceeded" } },
      "Rate limit exceeded",
      { "x-ratelimit-reset": resetTime.toString() }
    );

    const task = {
      id: "test-task",
      fns: {
        run: async () => {
          throw apiError;
        },
      },
      retry: {
        maxAttempts: 3,
        minDelay: 1000,
        maxDelay: 5000,
        factor: 2,
      },
    };

    const result = await executeTask(task, { test: "data" }, undefined);

    // Verify that the retry delay matches the rate limit reset time (with some jitter)
    expect(result.result.ok).toBe(false);
    expect(result.result).toMatchObject({
      ok: false,
      skippedRetrying: false,
      retry: expect.objectContaining({
        delay: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    });

    const delay = (result.result as any).retry.delay;
    expect(delay).toBeGreaterThan(29900); // Allow for some time passing during test
    expect(delay).toBeLessThan(32000); // Account for max 2000ms jitter
  });

  test("should return error and skip retrying if parsePayload throws", async () => {
    const parseError = new Error("Parse failed");
    const task = {
      id: "test-task",
      fns: {
        run: async () => {
          throw new Error("Should not reach run");
        },
        parsePayload: async () => {
          throw parseError;
        },
      },
    };

    const result = await executeTask(task, { foo: "bar" }, undefined);

    expect(result).toEqual({
      result: {
        ok: false,
        id: "test-run-id",
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.TASK_INPUT_ERROR,
          message: "TaskPayloadParsedError: Parsing payload with schema failed: Parse failed",
          stackTrace: expect.any(String),
        },
        skippedRetrying: true,
      },
    });
  });
});

function executeTask(
  task: TaskMetadataWithFunctions,
  payload: any,
  signal?: AbortSignal,
  retrySettings?: RetryOptions
) {
  const tracingSDK = new TracingSDK({
    url: "http://localhost:4318",
  });

  const tracer = new TriggerTracer({
    name: "test-task",
    version: "1.0.0",
    tracer: tracingSDK.getTracer("test-task"),
    logger: tracingSDK.getLogger("test-task"),
  });

  const consoleInterceptor = new ConsoleInterceptor(
    tracingSDK.getLogger("test-task"),
    false,
    false
  );

  const executor = new TaskExecutor(task, {
    tracingSDK,
    tracer,
    consoleInterceptor,
    retries: {
      enabledInDev: false,
      default: retrySettings ?? {
        maxAttempts: 1,
      },
    },
  });

  const execution: TaskRunExecution = {
    task: {
      id: "test-task",
      filePath: "test-task.ts",
    },
    attempt: {
      number: 1,
      startedAt: new Date(),
      id: "test-attempt-id",
      status: "success",
      backgroundWorkerId: "test-background-worker-id",
      backgroundWorkerTaskId: "test-background-worker-task-id",
    },
    run: {
      id: "test-run-id",
      payload: JSON.stringify(payload),
      payloadType: "application/json",
      metadata: {},
      startedAt: new Date(),
      tags: [],
      isTest: false,
      createdAt: new Date(),
      durationMs: 0,
      costInCents: 0,
      baseCostInCents: 0,
      priority: 0,
      maxDuration: 1000,
    },
    machine: {
      name: "micro",
      cpu: 1,
      memory: 1,
      centsPerMs: 0,
    },
    queue: {
      name: "test-queue",
      id: "test-queue-id",
    },
    environment: {
      type: "PRODUCTION",
      id: "test-environment-id",
      slug: "test-environment-slug",
    },
    organization: {
      id: "test-organization-id",
      name: "test-organization-name",
      slug: "test-organization-slug",
    },
    project: {
      id: "test-project-id",
      name: "test-project-name",
      slug: "test-project-slug",
      ref: "test-project-ref",
    },
  };

  const worker: ServerBackgroundWorker = {
    id: "test-background-worker-id",
    version: "1.0.0",
    contentHash: "test-content-hash",
    engine: "V2",
  };

  const $signal = signal ? signal : new AbortController().signal;

  return executor.execute(execution, execution, $signal);
}
