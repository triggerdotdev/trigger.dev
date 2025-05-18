import { Task, TaskIdentifier, TaskOutput, TaskPayload } from "@trigger.dev/sdk/v3";
import { MockExecutionResult, RunFnParams } from "./types.js";
import { mockTaskRegistry, setupMockTaskEnvironment } from "./mockTaskRegistry.js";

/**
 * A utility to execute a task with a mock run function
 * @param task - The task to execute
 * @param payload - The payload to pass to the task
 * @param options - Options for the mock execution
 * @returns The result of the task execution
 */
export async function executeMockTask<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>,
  payload: TInput,
  options?: {
    shouldFail?: boolean;
    error?: Error;
    delay?: number;
    mockDependencies?: Task<any, any, any>[];
  }
): Promise<MockExecutionResult<TOutput>> {
  const startTime = Date.now();
  let cleanup: (() => void) | undefined;
  
  try {
    if (options?.mockDependencies && options.mockDependencies.length > 0) {
      cleanup = setupMockTaskEnvironment((registry) => {
        options.mockDependencies?.forEach(mockTask => {
          registry.registerMockTask(mockTask);
        });
      });
    }

    if (options?.shouldFail) {
      await new Promise((_, reject) => {
        setTimeout(() => {
          reject(options.error ?? new Error("Mock task execution failed"));
        }, options?.delay ?? 0);
      });
      return { error: options.error ?? new Error("Mock task execution failed") };
    }

    const result = await task.triggerAndWait(payload).unwrap();
    return { 
      output: result as TOutput,
      executionTime: Date.now() - startTime 
    };
  } catch (error) {
    return { 
      error: error instanceof Error ? error : new Error(String(error)),
      executionTime: Date.now() - startTime
    };
  } finally {
    if (cleanup) {
      cleanup();
    }
  }
}

/**
 * A utility to test a task function directly
 * This bypasses the trigger mechanism and directly calls the task's run function
 */
export async function testTaskFunction<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput> & { run?: (payload: TInput, params: RunFnParams<any>) => Promise<TOutput> | TOutput },
  payload: TInput,
  params: Partial<RunFnParams<any>> = {},
  options?: {
    mockDependencies?: Task<any, any, any>[];
  }
): Promise<TOutput> {
  let cleanup: (() => void) | undefined;

  try {
    if (options?.mockDependencies && options.mockDependencies.length > 0) {
      cleanup = setupMockTaskEnvironment((registry) => {
        options.mockDependencies?.forEach(mockTask => {
          registry.registerMockTask(mockTask);
        });
      });
    }

    if (!task.run) {
      throw new Error(`Task ${task.id} does not have a run function`);
    }

    return await task.run(payload, {
      init: {},
      ctx: {
        attempt: 1,
        attemptNum: 1,
        id: `test-run-${Date.now()}`,
        runId: `test-run-${Date.now()}`,
        taskId: task.id,
        logger: console,
        payload,
      },
      ...(params as any),
    });
  } finally {
    if (cleanup) {
      cleanup();
    }
  }
}
