/**
 * CJS Require Test Fixture
 *
 * This file validates that the SDK can be required using CommonJS syntax.
 * This is critical for:
 * - Node.js < 22.12.0 (where require(ESM) is not enabled by default)
 * - AWS Lambda (intentionally disables require(ESM))
 * - Legacy Node.js applications
 */

// Test main export
const sdk = require("@trigger.dev/sdk");

// Test /v3 subpath
const sdkV3 = require("@trigger.dev/sdk/v3");

// Validate exports exist
const checks = [
  ["task", typeof sdk.task === "function"],
  ["taskV3", typeof sdkV3.task === "function"],
  ["logger", typeof sdk.logger === "object" && typeof sdk.logger.info === "function"],
  ["schedules", typeof sdk.schedules === "object"],
  ["runs", typeof sdk.runs === "object"],
  ["configure", typeof sdk.configure === "function"],
  ["queue", typeof sdk.queue === "function"],
  ["retry", typeof sdk.retry === "object"],
  ["wait", typeof sdk.wait === "object"],
  ["metadata", typeof sdk.metadata === "object"],
  ["tags", typeof sdk.tags === "object"],
];

let failed = false;
for (const [name, passed] of checks) {
  if (!passed) {
    console.error(`FAIL: ${name} export check failed`);
    failed = true;
  }
}

// Test task definition works
const myTask = sdk.task({
  id: "cjs-test-task",
  run: async (payload) => {
    return { received: payload };
  },
});

if (myTask.id !== "cjs-test-task") {
  console.error(`FAIL: task.id mismatch: expected "cjs-test-task", got "${myTask.id}"`);
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("SUCCESS: All CJS requires validated");
