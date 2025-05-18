import { 
  Task, 
  TaskIdentifier, 
  TaskOptions, 
  TaskOutput, 
  TaskPayload, 
  RunHandle, 
  BatchRunHandle, 
  TriggerOptions, 
  BatchResult,
  BatchItem
} from "@trigger.dev/sdk/v3";

import { 
  MockTaskOptions, 
  RunFnParams, 
  MockTaskRunPromise,
  TaskRunPromise,
  TriggerApiRequestOptions, 
  TriggerAndWaitOptions, 
  BatchTriggerOptions,
  BatchTriggerAndWaitItem
} from "./types.js";
import { mockTaskRegistry } from "./mockTaskRegistry.js";

/**
 * Creates a mock task that can be used for testing
 * @param options - Mock task options
 * @returns A mock task that can be used for testing
 */
export function mockTask<TIdentifier extends string, TInput = void, TOutput = unknown>(
  mockOptions: MockTaskOptions<TIdentifier, TInput, TOutput>
): Task<TIdentifier, TInput, TOutput> {
  const mockTask = {
    id: mockOptions.id,
    trigger: async (payload: TInput, triggerOptions?: TriggerOptions, requestOptions?: TriggerApiRequestOptions) => {
      const runId = `mock-run-id-${Date.now()}`;
      const idempotencyKey = triggerOptions?.idempotencyKey ?? `mock-idempotency-key-${Date.now()}`;
      
      return {
        id: runId,
        idempotencyKey,
        taskId: mockOptions.id,
        publicAccessToken: "mock-token",
        isCached: false,
      } as unknown as RunHandle<TIdentifier, TInput, TOutput>;
    },
    batchTrigger: async (items: BatchItem<TInput>[], batchOptions?: BatchTriggerOptions, requestOptions?: TriggerApiRequestOptions) => {
      const batchId = `mock-batch-id-${Date.now()}`;
      const idempotencyKey = batchOptions?.idempotencyKey ?? `mock-batch-idempotency-key-${Date.now()}`;
      
      return {
        id: batchId,
        idempotencyKey,
        runs: items.map((_, index) => ({
          id: `mock-run-id-${Date.now()}-${index}`,
          idempotencyKey: `mock-idempotency-key-${Date.now()}-${index}`,
          taskId: mockOptions.id,
          publicAccessToken: "mock-token",
          isCached: false,
        })),
        publicAccessToken: "mock-token",
        isCached: false,
      } as unknown as BatchRunHandle<TIdentifier, TInput, TOutput>;
    },
    triggerAndWait: (payload: TInput, options?: TriggerAndWaitOptions) => {
      const executor = (
        resolve: (value: any) => void,
        reject: (reason?: any) => void
      ) => {
        if (mockOptions.shouldFail) {
          setTimeout(() => {
            reject(mockOptions.error ?? new Error("Mock task failed"));
          }, mockOptions.delay ?? 0);
        } else {
          setTimeout(() => {
            resolve({
              ok: true,
              output: mockOptions.output as TOutput,
              error: undefined,
            });
          }, mockOptions.delay ?? 0);
        }
      };

      // Create a mock TaskRunPromise
      const mockPromise = new MockTaskRunPromise(executor, mockOptions.id);
      
      return mockPromise as any as TaskRunPromise<TIdentifier, TOutput>;
    },
    batchTriggerAndWait: async (items: BatchTriggerAndWaitItem<TInput>[], batchOptions?: any) => {
      return {
        id: `mock-batch-id-${Date.now()}`,
        runs: items.map((item, index) => {
          if (mockOptions.shouldFail) {
            return {
              ok: false,
              error: mockOptions.error ?? new Error("Mock task failed"),
            };
          }
          return {
            ok: true,
            data: mockOptions.output,
          };
        }),
      } as unknown as BatchResult<TIdentifier, TOutput>;
    }
  } as unknown as Task<TIdentifier, TInput, TOutput>;

  (mockTask as any)[Symbol.for("trigger.dev/task")] = true;
  (mockTask as any)[Symbol.for("trigger.dev/mock-task")] = true;

  mockTaskRegistry.registerMockTask(mockTask);

  return mockTask;
}

/**
 * Checks if a task is a mock task
 * @param task - The task to check
 * @returns True if the task is a mock task
 */
export function isMockTask(task: Task<any, any, any>): boolean {
  return !!(task as any)[Symbol.for("trigger.dev/mock-task")];
}

/**
 * Creates a mock task for unit testing
 * Unlike mockTask, this creates a fully functional mock that can be used to test complex task interactions
 */
export function createMockTaskForUnitTest<TIdentifier extends string, TInput = void, TOutput = unknown>(
  options: MockTaskOptions<TIdentifier, TInput, TOutput> & {
    runFn?: (payload: TInput, params: RunFnParams<any>) => Promise<TOutput> | TOutput;
  }
): Task<TIdentifier, TInput, TOutput> {
  const mockTaskInstance = mockTask(options);
  
  if (options.runFn) {
    (mockTaskInstance as any).run = options.runFn;
  }
  
  return mockTaskInstance;
}

/**
 * A utility to mock any task dependencies in a unit test
 * @param taskToTest - The task being tested
 * @param dependencies - Mock dependencies to register
 * @returns A function to clean up mocks after test
 */
export function mockTaskDependencies<TIdentifier extends string, TInput = void, TOutput = unknown>(
  taskToTest: Task<TIdentifier, TInput, TOutput>,
  dependencies: Task<any, any, any>[]
): () => void {
  mockTaskRegistry.registerMockTasks(dependencies);
  
  return () => {
    mockTaskRegistry.clear();
  };
}
