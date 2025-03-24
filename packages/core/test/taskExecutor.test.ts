import { describe, expect, test } from "vitest";
import { ConsoleInterceptor } from "../src/v3/consoleInterceptor.js";
import {
  RunFnParams,
  ServerBackgroundWorker,
  TaskMetadataWithFunctions,
  TaskRunExecution,
} from "../src/v3/index.js";
import { TracingSDK } from "../src/v3/otel/tracingSDK.js";
import { TriggerTracer } from "../src/v3/tracer.js";
import { TaskExecutor } from "../src/v3/workers/taskExecutor.js";
import { StandardLifecycleHooksManager } from "../src/v3/lifecycleHooks/manager.js";
import { lifecycleHooks } from "../src/v3/index.js";

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

    const result = await executeTask(task, {});

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

    const result = await executeTask(task, {});

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    const result = await executeTask(task, { test: "data" });

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

    expect((result as any).result.retry.delay).toBeCloseTo(30000, -1);
  });
});

function executeTask(task: TaskMetadataWithFunctions, payload: any) {
  const tracingSDK = new TracingSDK({
    url: "http://localhost:4318",
  });

  const tracer = new TriggerTracer({
    name: "test-task",
    version: "1.0.0",
    tracer: tracingSDK.getTracer("test-task"),
    logger: tracingSDK.getLogger("test-task"),
  });

  const consoleInterceptor = new ConsoleInterceptor(tracingSDK.getLogger("test-task"), false);

  const executor = new TaskExecutor(task, {
    tracingSDK,
    tracer,
    consoleInterceptor,
    retries: {
      enabledInDev: false,
      default: {
        maxAttempts: 1,
      },
    },
    handleErrorFn: undefined,
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

  return executor.execute(execution, worker, {});
}
