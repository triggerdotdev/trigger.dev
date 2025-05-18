import { Task, TaskIdentifier, TaskOutput, TaskPayload } from "@trigger.dev/sdk/v3";
import { TaskResolutionMap } from "./types.js";

/**
 * A registry for managing mock tasks
 * This allows for mocking task dependencies in unit tests
 */
class MockTaskRegistry {
  private mockTasks: TaskResolutionMap = {};

  /**
   * Register a mock task
   */
  registerMockTask<TIdentifier extends string, TInput = void, TOutput = unknown>(
    task: Task<TIdentifier, TInput, TOutput>
  ) {
    this.mockTasks[task.id] = task;
  }

  /**
   * Register multiple mock tasks
   */
  registerMockTasks(tasks: Task<any, any, any>[]) {
    tasks.forEach(task => this.registerMockTask(task));
  }

  /**
   * Resolve a task by ID
   */
  resolveTask<TIdentifier extends string, TInput = void, TOutput = unknown>(
    taskId: string
  ): Task<TIdentifier, TInput, TOutput> | undefined {
    return this.mockTasks[taskId] as Task<TIdentifier, TInput, TOutput> | undefined;
  }

  /**
   * Check if a task is registered
   */
  hasTask(taskId: string): boolean {
    return !!this.mockTasks[taskId];
  }

  /**
   * Clear all registered mock tasks
   */
  clear() {
    this.mockTasks = {};
  }

  /**
   * Get all registered mock tasks
   */
  getAllTasks(): TaskResolutionMap {
    return { ...this.mockTasks };
  }
}

export const mockTaskRegistry = new MockTaskRegistry();

/**
 * Enables task mocking by intercepting task resolution
 * This patches the global task registry to use our mock tasks when available
 */
export function enableTaskMocking() {
  
  const originalResolveTask = (global as any).__TRIGGER_DEV_RESOLVE_TASK;
  
  if (!originalResolveTask) {
    console.warn("Task resolution function not found. Task mocking may not work correctly.");
    return () => {}; // Return no-op cleanup function
  }
  
  (global as any).__TRIGGER_DEV_RESOLVE_TASK = (taskId: string) => {
    if (mockTaskRegistry.hasTask(taskId)) {
      return mockTaskRegistry.resolveTask(taskId);
    }
    
    return originalResolveTask(taskId);
  };
  
  return () => {
    (global as any).__TRIGGER_DEV_RESOLVE_TASK = originalResolveTask;
  };
}

/**
 * A helper function to create a test environment with mocked tasks
 * @param setupFn - A function to set up the test environment
 * @returns A function to clean up the test environment
 */
export function setupMockTaskEnvironment(setupFn?: (registry: MockTaskRegistry) => void): () => void {
  if (setupFn) {
    setupFn(mockTaskRegistry);
  }
  
  const cleanupMocking = enableTaskMocking();
  
  return () => {
    cleanupMocking();
    mockTaskRegistry.clear();
  };
}
