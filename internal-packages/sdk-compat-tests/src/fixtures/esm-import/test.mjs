/**
 * ESM Import Test Fixture
 *
 * This file validates that the SDK can be imported using ESM syntax.
 * It tests all major export paths and verifies runtime functionality.
 */

// Test main export
import { task, logger, schedules, runs, configure, queue, retry, wait, metadata, tags } from "@trigger.dev/sdk";

// Test /v3 subpath (legacy, but should still work)
import { task as taskV3 } from "@trigger.dev/sdk/v3";

// Validate exports are functions/objects
const checks = [
  ["task", typeof task === "function"],
  ["taskV3", typeof taskV3 === "function"],
  ["logger", typeof logger === "object" && typeof logger.info === "function"],
  ["schedules", typeof schedules === "object"],
  ["runs", typeof runs === "object"],
  ["configure", typeof configure === "function"],
  ["queue", typeof queue === "function"],
  ["retry", typeof retry === "object"],
  ["wait", typeof wait === "object"],
  ["metadata", typeof metadata === "object"],
  ["tags", typeof tags === "object"],
];

let failed = false;
for (const [name, passed] of checks) {
  if (!passed) {
    console.error(`FAIL: ${name} export check failed`);
    failed = true;
  }
}

// Test task definition works
const myTask = task({
  id: "esm-test-task",
  run: async (payload) => {
    return { received: payload };
  },
});

if (myTask.id !== "esm-test-task") {
  console.error(`FAIL: task.id mismatch: expected "esm-test-task", got "${myTask.id}"`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("SUCCESS: All ESM imports validated");
