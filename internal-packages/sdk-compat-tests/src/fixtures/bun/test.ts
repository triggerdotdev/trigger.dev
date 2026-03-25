/**
 * Bun Import Test Fixture
 *
 * Tests that the SDK works correctly with Bun runtime.
 * Bun has high Node.js compatibility but uses its own module resolver.
 */

import { task, logger, schedules, runs, configure, queue, retry, wait } from "@trigger.dev/sdk";

// Validate exports exist
const checks: [string, boolean][] = [
  ["task", typeof task === "function"],
  ["logger", typeof logger === "object" && typeof logger.info === "function"],
  ["schedules", typeof schedules === "object"],
  ["runs", typeof runs === "object"],
  ["configure", typeof configure === "function"],
  ["queue", typeof queue === "function"],
  ["retry", typeof retry === "object"],
  ["wait", typeof wait === "object"],
];

let failed = false;
for (const [name, passed] of checks) {
  if (!passed) {
    console.error(`FAIL: ${name} export check failed`);
    failed = true;
  }
}

// Test task definition with types
interface Payload {
  message: string;
}

const myTask = task({
  id: "bun-test-task",
  run: async (payload: Payload) => {
    return { received: payload.message };
  },
});

if (myTask.id !== "bun-test-task") {
  console.error(`FAIL: task.id mismatch`);
  failed = true;
}

// Test queue definition
const myQueue = queue({
  name: "bun-test-queue",
  concurrencyLimit: 5,
});

if (!myQueue) {
  console.error(`FAIL: queue creation failed`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("SUCCESS: Bun imports validated");
