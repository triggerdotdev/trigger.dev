import { Task, TaskIdentifier, TaskOutput, TaskPayload } from "@trigger.dev/sdk/v3";
import { MockHooksCallInfo, TaskRunContext } from "./types.js";

/**
 * A registry of all hook calls
 */
class MockHooksRegistry {
  private hookCalls: Record<string, MockHooksCallInfo> = {};

  /**
   * Record a hook call
   */
  recordHookCall<TPayload = any, TOutput = any, TError = any>(
    taskId: string,
    hookType: keyof MockHooksCallInfo,
    payload?: TPayload,
    output?: TOutput,
    error?: TError
  ) {
    if (!this.hookCalls[taskId]) {
      this.hookCalls[taskId] = {
        onStartCalled: false,
        onSuccessCalled: false,
        onFailureCalled: false,
        onCompleteCalled: false,
      };
    }

    const hookCallInfo = this.hookCalls[taskId];
    
    hookCallInfo[hookType] = true;

    if (payload !== undefined) {
      hookCallInfo.payload = payload;
    }
    
    if (output !== undefined) {
      hookCallInfo.output = output;
    }
    
    if (error !== undefined) {
      hookCallInfo.error = error;
    }
  }

  /**
   * Get hook calls for a specific task
   */
  getHookCallsForTask(taskId: string): MockHooksCallInfo | undefined {
    return this.hookCalls[taskId];
  }

  /**
   * Clear all hook calls
   */
  clearHookCalls() {
    this.hookCalls = {};
  }
}

export const mockHooksRegistry = new MockHooksRegistry();

/**
 * Create mock hooks for a task
 */
export function createMockHooks<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>
) {
  return {
    onStart: async (payload: TInput, ctx: TaskRunContext) => {
      mockHooksRegistry.recordHookCall(task.id, "onStartCalled", payload);
    },
    onSuccess: async (payload: TInput, output: TOutput) => {
      mockHooksRegistry.recordHookCall(task.id, "onSuccessCalled", payload, output);
    },
    onFailure: async (payload: TInput, error: Error) => {
      mockHooksRegistry.recordHookCall(task.id, "onFailureCalled", payload, undefined, error);
    },
    onComplete: async (payload: TInput, result: { ok: boolean; data?: TOutput; error?: Error }) => {
      mockHooksRegistry.recordHookCall(
        task.id, 
        "onCompleteCalled", 
        payload, 
        result.ok ? result.data : undefined, 
        result.ok ? undefined : result.error
      );
    },
  };
}

/**
 * Verify that a specific hook was called for a task
 */
export function verifyHookCalled<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>,
  hookType: keyof Omit<MockHooksCallInfo, "payload" | "output" | "error">
): boolean {
  const hookCalls = mockHooksRegistry.getHookCallsForTask(task.id);
  
  if (!hookCalls) {
    return false;
  }

  return hookCalls[hookType];
}
