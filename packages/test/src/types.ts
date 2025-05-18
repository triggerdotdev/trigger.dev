import { 
  RunHandle,
  BatchRunHandle,
  TaskRunResult,
  BatchResult,
  TriggerOptions,
  Task,
  TaskIdentifier,
  TaskOptions,
  TaskOutput,
  TaskPayload,
  BatchItem
} from "@trigger.dev/sdk/v3";

export interface TaskRunContext {
  id: string;
  runId: string;
  taskId: string;
  attempt: number;
  attemptNum: number;
  payload: any;
  logger: Console;
}

export interface TriggerApiRequestOptions {
  apiUrl?: string;
  apiKey?: string;
}

export interface TriggerAndWaitOptions {
  idempotencyKey?: string;
  queue?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface BatchTriggerOptions {
  idempotencyKey?: string;
  queue?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

// Define our own BatchTriggerAndWaitItem
export interface BatchTriggerAndWaitItem<TInput = any> {
  payload: TInput;
  idempotencyKey?: string;
}

// Define a TaskRunPromise type alias to use our MockTaskRunPromise
export type TaskRunPromise<TIdentifier extends string, TOutput> = MockTaskRunPromise<TIdentifier, TOutput>;

export type RunFnParams<TInitOutput = any> = {
  ctx: TaskRunContext;
  init: TInitOutput;
  signal?: AbortSignal;
};

export class MockTaskRunPromise<TIdentifier extends string, TOutput> implements Promise<TaskRunResult<TIdentifier, TOutput>> {
  private promise: Promise<TaskRunResult<TIdentifier, TOutput>>;
  private readonly _taskId: string;
  public readonly taskId: TIdentifier;

  constructor(
    executor: (
      resolve: (value: TaskRunResult<TIdentifier, TOutput> | PromiseLike<TaskRunResult<TIdentifier, TOutput>>) => void,
      reject: (reason?: any) => void
    ) => void,
    taskId: TIdentifier
  ) {
    this.promise = new Promise(executor);
    this._taskId = taskId;
    this.taskId = taskId;
  }

  unwrap(): Promise<TOutput> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw new Error(`Error in ${this._taskId}: ${result.error}`);
      }
    });
  }

  then<TResult1 = TaskRunResult<TIdentifier, TOutput>, TResult2 = never>(
    onfulfilled?: ((value: TaskRunResult<TIdentifier, TOutput>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ): Promise<TaskRunResult<TIdentifier, TOutput> | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<TaskRunResult<TIdentifier, TOutput>> {
    return this.promise.finally(onfinally);
  }

  [Symbol.toStringTag]: string = "TaskRunPromise";
}

export interface MockTaskOptions<TIdentifier extends string, TInput = void, TOutput = unknown> {
  id: TIdentifier;
  payload?: TInput;
  output?: TOutput;
  error?: Error;
  shouldFail?: boolean;
  delay?: number;
}

export interface MockExecutionResult<TOutput = unknown> {
  output?: TOutput;
  error?: Error;
  executionTime?: number;
}

export interface MockTriggerOptions {
  delay?: number;
  idempotencyKey?: string;
  queue?: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface MockHooksCallInfo<TPayload = any, TOutput = any, TError = any> {
  onStartCalled: boolean;
  onSuccessCalled: boolean;
  onFailureCalled: boolean;
  onCompleteCalled: boolean;
  payload?: TPayload;
  output?: TOutput;
  error?: TError;
}

export interface TaskResolutionMap {
  [taskId: string]: Task<any, any, any>;
}
