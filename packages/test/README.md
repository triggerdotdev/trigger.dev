# @trigger.dev/test

Testing utilities for trigger.dev tasks.

## Installation

```bash
npm install --save-dev @trigger.dev/test
```

## Usage

### Creating a mock task

```typescript
import { mockTask } from "@trigger.dev/test";

const task = mockTask({
  id: "test-task",
  output: { success: true },
});

// Use the mock task in your tests
const result = await task.triggerAndWait({}).unwrap();
console.log(result); // { success: true }
```

### Unit testing a task with mocked dependencies

```typescript
import { mockTask, testTaskFunction } from "@trigger.dev/test";

// Create a mock for a dependent task
const dependentTask = mockTask({
  id: "dependent-task",
  output: { result: "mocked-result" },
});

// Test a task that uses the dependent task
const result = await testTaskFunction(mainTask, { input: "test" }, {}, {
  mockDependencies: [dependentTask]
});

// Verify the result
expect(result).toEqual({
  mainResult: "Processed: mocked-result",
  input: "test"
});
```

### Setting up a test environment with mocked tasks

```typescript
import { setupMockTaskEnvironment, mockTask } from "@trigger.dev/test";

// Set up the test environment
const cleanup = setupMockTaskEnvironment((registry) => {
  // Register mock tasks
  registry.registerMockTask(mockTask({
    id: "task-1",
    output: { result: "mocked-result-1" },
  }));
  
  registry.registerMockTask(mockTask({
    id: "task-2",
    output: { result: "mocked-result-2" },
  }));
});

// Run your tests...

// Clean up
cleanup();
```

### Verifying task triggers

```typescript
import { mockTask, verifyTaskTriggered, getTaskTriggerCount } from "@trigger.dev/test";

const task = mockTask({
  id: "test-task",
  output: { success: true },
});

// Trigger the task
await task.trigger({ data: "test" });

// Verify the task was triggered
console.log(verifyTaskTriggered(task)); // true
console.log(verifyTaskTriggered(task, { data: "test" })); // true
console.log(getTaskTriggerCount(task)); // 1
```

### Testing hooks

```typescript
import { mockTask, createMockHooks, verifyHookCalled } from "@trigger.dev/test";

const task = mockTask({
  id: "test-task",
  output: { success: true },
});

const hooks = createMockHooks(task);

// Call the hooks
await hooks.onStart({ data: "test" }, {} as any);
await hooks.onSuccess({ data: "test" }, { success: true });

// Verify the hooks were called
console.log(verifyHookCalled(task, "onStartCalled")); // true
console.log(verifyHookCalled(task, "onSuccessCalled")); // true
```

## API Reference

### Task Mocking

- `mockTask(options)`: Creates a mock task that can be used for testing.
- `isMockTask(task)`: Checks if a task is a mock task.
- `createMockTaskForUnitTest(options)`: Creates a mock task with a custom run function.
- `mockTaskDependencies(taskToTest, dependencies)`: Mocks dependencies for a specific task.

### Task Testing

- `executeMockTask(task, payload, options)`: Executes a task with mocked dependencies.
- `testTaskFunction(task, payload, params, options)`: Tests a task's run function directly.
- `setupMockTaskEnvironment(setupFn)`: Sets up a test environment with mocked tasks.

### Trigger Verification

- `verifyTaskTriggered(task, expectedPayload)`: Verifies that a task was triggered with the expected payload.
- `getTaskTriggerCount(task)`: Gets the number of times a task was triggered.
- `clearAllMockTriggers()`: Clears all mock triggers.

### Hook Testing

- `createMockHooks(task)`: Creates mock hooks for a task.
- `verifyHookCalled(task, hookType)`: Verifies that a specific hook was called for a task.
