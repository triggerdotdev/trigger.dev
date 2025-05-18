import { Task, TaskIdentifier, TaskPayload } from "@trigger.dev/sdk/v3";
import { MockTriggerOptions } from "./types.js";

/**
 * A record of all the times a mock task was triggered
 */
type MockTriggerRecord<TInput = any> = {
  taskId: string;
  payload: TInput;
  options?: MockTriggerOptions;
  timestamp: number;
};

/**
 * A registry of all mock triggers
 */
class MockTriggerRegistry {
  private triggers: MockTriggerRecord[] = [];

  /**
   * Record a task trigger
   */
  recordTrigger<TInput = any>(
    taskId: string,
    payload: TInput,
    options?: MockTriggerOptions
  ) {
    this.triggers.push({
      taskId,
      payload,
      options,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all triggers for a specific task
   */
  getTriggersForTask(taskId: string): MockTriggerRecord[] {
    return this.triggers.filter((trigger) => trigger.taskId === taskId);
  }

  /**
   * Get all triggers
   */
  getAllTriggers(): MockTriggerRecord[] {
    return [...this.triggers];
  }

  /**
   * Clear all triggers
   */
  clearTriggers() {
    this.triggers = [];
  }

  /**
   * Clear triggers for a specific task
   */
  clearTriggersForTask(taskId: string) {
    this.triggers = this.triggers.filter((trigger) => trigger.taskId !== taskId);
  }
}

export const mockTriggerRegistry = new MockTriggerRegistry();

/**
 * Create a mock trigger function for a task
 */
export function createMockTrigger<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>
) {
  return async (
    payload: TaskPayload<Task<TIdentifier, TInput, TOutput>>,
    options?: MockTriggerOptions
  ) => {
    mockTriggerRegistry.recordTrigger(task.id, payload, options);
    
    return {
      id: `mock-run-id-${Date.now()}`,
      idempotencyKey: options?.idempotencyKey ?? `mock-idempotency-key-${Date.now()}`,
    };
  };
}

/**
 * Verify that a task was triggered with the expected payload
 */
export function verifyTaskTriggered<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>,
  expectedPayload?: TInput
): boolean {
  const triggers = mockTriggerRegistry.getTriggersForTask(task.id);
  
  if (triggers.length === 0) {
    return false;
  }

  if (expectedPayload === undefined) {
    return true;
  }

  return triggers.some((trigger) => {
    return JSON.stringify(trigger.payload) === JSON.stringify(expectedPayload);
  });
}

/**
 * Get the number of times a task was triggered
 */
export function getTaskTriggerCount<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown
>(
  task: Task<TIdentifier, TInput, TOutput>
): number {
  return mockTriggerRegistry.getTriggersForTask(task.id).length;
}

/**
 * Clear all mock triggers
 */
export function clearAllMockTriggers() {
  mockTriggerRegistry.clearTriggers();
}
