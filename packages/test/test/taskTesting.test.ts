import { describe, it, expect, beforeEach } from "vitest";
import { 
  mockTask, 
  mockTaskDependencies, 
  testTaskFunction, 
  executeMockTask,
  setupMockTaskEnvironment
} from "../src";
import { RunFnParams } from "@trigger.dev/core";
import { Task } from "@trigger.dev/sdk/v3";

const dependentTask = mockTask({
  id: "dependent-task",
  output: { result: "dependent-task-result" },
});

const mainTask = {
  id: "main-task",
  run: async (payload: { input: string }, params: RunFnParams<any>) => {
    const result = await dependentTask.triggerAndWait({ data: payload.input }).unwrap();
    return {
      mainResult: `Processed: ${result.result}`,
      input: payload.input
    };
  }
} as Task<"main-task", { input: string }, { mainResult: string, input: string }>;

describe("Task Unit Testing", () => {
  beforeEach(() => {
    setupMockTaskEnvironment();
  });

  it("should test a task with mocked dependencies", async () => {
    const cleanup = mockTaskDependencies(mainTask, [dependentTask]);
    
    try {
      const result = await testTaskFunction(mainTask, { input: "test-input" });
      
      expect(result).toEqual({
        mainResult: "Processed: dependent-task-result",
        input: "test-input"
      });
    } finally {
      cleanup();
    }
  });

  it("should execute a task with mocked dependencies", async () => {
    const result = await executeMockTask(mainTask, { input: "test-input" }, {
      mockDependencies: [dependentTask]
    });
    
    expect(result.output).toEqual({
      mainResult: "Processed: dependent-task-result",
      input: "test-input"
    });
  });

  it("should allow customizing the mock dependency behavior", async () => {
    const customDependentTask = mockTask({
      id: "dependent-task",
      output: { result: "custom-result" },
    });
    
    const result = await executeMockTask(mainTask, { input: "test-input" }, {
      mockDependencies: [customDependentTask]
    });
    
    expect(result.output).toEqual({
      mainResult: "Processed: custom-result",
      input: "test-input"
    });
  });
});
