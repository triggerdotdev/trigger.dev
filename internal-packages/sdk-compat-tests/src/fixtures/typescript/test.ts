/**
 * TypeScript Import Test Fixture
 *
 * This file validates that the SDK types work correctly with TypeScript.
 * It tests type inference, generics, and type-only imports.
 */

import { queue, task, type RetryOptions } from "@trigger.dev/sdk";

// Type-only import test

// Test typed task with payload
interface MyPayload {
  message: string;
  count: number;
}

interface MyOutput {
  processed: boolean;
  result: string;
}

const typedTask = task({
  id: "typescript-test-task",
  run: async (payload: MyPayload, { ctx }): Promise<MyOutput> => {
    // Verify context type
    const _runId: string = ctx.run.id;

    return {
      processed: true,
      result: `Processed ${payload.message} with count ${payload.count}`,
    };
  },
});

// Verify task type inference
type TaskPayload = Parameters<typeof typedTask.trigger>[0];
type _PayloadCheck = TaskPayload extends MyPayload ? true : never;

// Test queue definition
const _myQueue = queue({
  name: "test-queue",
  concurrencyLimit: 10,
});

// Test retry options type
const _retryOpts: RetryOptions = {
  maxAttempts: 3,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 30000,
};

// Validate runtime
if (typedTask.id !== "typescript-test-task") {
  console.error(`FAIL: task.id mismatch`);
  process.exit(1);
}

console.log("SUCCESS: TypeScript types validated");
