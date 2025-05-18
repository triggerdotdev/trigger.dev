import { mockTask, isMockTask, createMockTaskForUnitTest, mockTaskDependencies } from "./mockTask.js";
import { executeMockTask, testTaskFunction } from "./taskTesting.js";
import { setupMockTaskEnvironment } from "./mockTaskRegistry.js";
import { verifyTaskTriggered, getTaskTriggerCount, clearAllMockTriggers } from "./mockTrigger.js";
import { createMockHooks, verifyHookCalled } from "./mockHooks.js";

export * from "./types.js";
export * from "./mockTask.js";
export * from "./mockTrigger.js";
export * from "./mockHooks.js";
export * from "./taskTesting.js";
export * from "./mockTaskRegistry.js";

export const triggerTest = {
  mockTask,
  isMockTask,
  createMockTaskForUnitTest,
  mockTaskDependencies,
  
  executeMockTask,
  testTaskFunction,
  
  setupMockTaskEnvironment,
  
  verifyTaskTriggered,
  getTaskTriggerCount,
  clearAllMockTriggers,
  
  createMockHooks,
  verifyHookCalled,
};
