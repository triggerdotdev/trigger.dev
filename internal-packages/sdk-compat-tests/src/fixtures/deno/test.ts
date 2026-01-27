/**
 * Deno Import Test Fixture
 *
 * Tests that the SDK can be imported in Deno using Node.js compatibility.
 * The CI workflow installs the SDK into node_modules via npm for local resolution.
 */

// Use bare specifier - resolved via node_modules when nodeModulesDir is enabled
import { task, logger, schedules, runs, configure, queue, retry, wait, metadata, tags } from "@trigger.dev/sdk";

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

// Test task definition with types
interface Payload {
  message: string;
}

const myTask = task({
  id: "deno-test-task",
  run: async (payload: Payload) => {
    return { received: payload.message };
  },
});

if (myTask.id !== "deno-test-task") {
  console.error(`FAIL: task.id mismatch`);
  failed = true;
}

// Test queue definition
const myQueue = queue({
  name: "deno-test-queue",
  concurrencyLimit: 5,
});

if (!myQueue) {
  console.error(`FAIL: queue creation failed`);
  failed = true;
}

if (failed) {
  Deno.exit(1);
}

console.log("SUCCESS: Deno imports validated");
